import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import multer from "multer"
import crypto from "crypto"


import { PDFParse } from "pdf-parse"
import mammoth from "mammoth"

import {
    HumanMessage,
    SystemMessage,
    AIMessage
} from "@langchain/core/messages"

import llm from "./config/llm.js"

import {
    indexResume,
    retrieveResumeContext,
    deleteResumeVectors
} from "./rag.js"
import connectDB from "./config/db.js"
import resumeRouter from "./routes/resume.routes.js"



// ======================================================
// ENVIRONMENT
// ======================================================

dotenv.config()


// ======================================================
// APP
// ======================================================

const app = express()

const PORT =
    process.env.PORT || 8002

const FRONTEND_URL =
    process.env.FRONTEND_URL ||
    "http://localhost:5173"


// ======================================================
// MIDDLEWARE
// ======================================================

app.use(
    cors({
        origin: FRONTEND_URL,
        credentials: true
    })
)

app.use(
    express.json({
        limit: "2mb"
    })
)


app.get("/health", (_req, res) => {
    res.status(200).json({
        status: "ok",
        service: "resume",
    });
});

app.use('/',resumeRouter);


// ======================================================
// MULTER
// ======================================================

const upload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                10 * 1024 * 1024
        },

        fileFilter:
            (req, file, cb) => {

                const allowedMimeTypes = [
                    "application/pdf",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ]

                const allowedExtensions = [
                    ".pdf",
                    ".docx"
                ]

                const extension =
                    "." +
                    file.originalname
                        .split(".")
                        .pop()
                        .toLowerCase()

                if (
                    allowedMimeTypes.includes(
                        file.mimetype
                    ) &&
                    allowedExtensions.includes(
                        extension
                    )
                ) {
                    cb(null, true)
                    return
                }

                cb(
                    new Error(
                        "Only PDF and DOCX resume files are supported."
                    )
                )
            }
    })


// ======================================================
// IN-MEMORY RESUME STORE
// ======================================================

const resumeStore =
    new Map()

const RESUME_TTL =
    1000 * 60 * 60


function generateResumeId() {
    return crypto.randomUUID()
}


function saveResume(
    resumeId,
    data
) {
    const now =
        Date.now()

    resumeStore.set(
        resumeId,
        {
            ...data,

            createdAt:
                now,

            expiresAt:
                now + RESUME_TTL
        }
    )
}


function getResume(
    resumeId
) {
    const resume =
        resumeStore.get(
            resumeId
        )

    if (!resume) {
        return null
    }

    if (
        Date.now() >
        resume.expiresAt
    ) {
        resumeStore.delete(
            resumeId
        )

        return null
    }

    return resume
}


// ======================================================
// CLEANUP EXPIRED RESUMES + RAG VECTORS
// ======================================================

setInterval(
    async () => {

        const now =
            Date.now()

        for (
            const [
                id,
                resume
            ]
            of resumeStore.entries()
        ) {

            if (
                now >
                resume.expiresAt
            ) {

                try {

                    await deleteResumeVectors(
                        id
                    )

                } catch (error) {

                    console.error(
                        `Failed to delete RAG vectors for ${id}:`,
                        error
                    )
                }

                resumeStore.delete(
                    id
                )
            }
        }

    },
    10 * 60 * 1000
)


// ======================================================
// BASIC ROUTE
// ======================================================

app.get(
    "/",
    (req, res) => {

        res.json({
            success: true,
            message:
                "Resume Analyzer API is running"
        })
    }
)


// ======================================================
// TEXT CLEANING
// ======================================================

function cleanResumeText(
    text
) {

    if (!text) {
        return ""
    }

    return text
        .replace(
            /\r\n/g,
            "\n"
        )
        .replace(
            /\r/g,
            "\n"
        )
        .replace(
            /[ \t]+/g,
            " "
        )
        .replace(
            /\n{3,}/g,
            "\n\n"
        )
        .replace(
            /\s+([,.!?])/g,
            "$1"
        )
        .trim()
}


// ======================================================
// PDF EXTRACTION
// ======================================================

async function extractPdfText(
    buffer
) {

    const parser =
        new PDFParse({
            data: buffer
        })

    try {

        const result =
            await parser.getText()

        return cleanResumeText(
            result.text
        )

    } finally {

        if (
            typeof parser.destroy ===
            "function"
        ) {
            await parser.destroy()
        }
    }
}


// ======================================================
// DOCX EXTRACTION
// ======================================================

async function extractDocxText(
    buffer
) {

    const result =
        await mammoth.extractRawText({
            buffer
        })

    return cleanResumeText(
        result.value
    )
}


// ======================================================
// EXTRACT RESUME
// ======================================================

async function extractResumeText(
    file
) {

    if (!file) {
        throw new Error(
            "Resume file is required."
        )
    }

    const extension =
        "." +
        file.originalname
            .split(".")
            .pop()
            .toLowerCase()

    if (
        extension ===
        ".pdf"
    ) {
        return extractPdfText(
            file.buffer
        )
    }

    if (
        extension ===
        ".docx"
    ) {
        return extractDocxText(
            file.buffer
        )
    }

    throw new Error(
        "Unsupported resume format. Please upload PDF or DOCX."
    )
}


// ======================================================
// RESUME VALIDATION
// ======================================================

function validateResumeText(
    text
) {

    if (
        !text ||
        !text.trim()
    ) {
        throw new Error(
            "Could not extract text from this resume."
        )
    }

    if (
        text.trim().length <
        80
    ) {
        throw new Error(
            "The resume contains too little readable text."
        )
    }

    return text.trim()
}


// ======================================================
// RESUME UPLOAD + RAG INDEXING
// ======================================================

app.post(
    "/uploadresumeintelligence",

    upload.single("resume"),

    async (
        req,
        res
    ) => {

        const startTime =
            Date.now()

        try {

            if (!req.file) {

                return res
                    .status(400)
                    .json({
                        success: false,
                        message:
                            "Please upload a resume."
                    })
            }


            // ------------------------------------------
            // Extract
            // ------------------------------------------

            const resumeText =
                await extractResumeText(
                    req.file
                )


            // ------------------------------------------
            // Validate
            // ------------------------------------------

            validateResumeText(
                resumeText
            )


            // ------------------------------------------
            // Generate ID
            // ------------------------------------------

            const resumeId =
                generateResumeId()


            // ------------------------------------------
            // RAG indexing
            // ------------------------------------------

            const ragStartTime =
                Date.now()

            const ragResult =
                await indexResume({
                    resumeId,
                    resumeText
                })

            const ragTime =
                Date.now() -
                ragStartTime


            // ------------------------------------------
            // Save session
            // ------------------------------------------

            saveResume(
                resumeId,
                {
                    fileName:
                        req.file.originalname,

                    mimeType:
                        req.file.mimetype,

                    resumeText,

                    messages: [],

                    rag: {
                        indexed: true,

                        chunks:
                            ragResult.chunks
                    }
                }
            )


            // ------------------------------------------
            // Response
            // ------------------------------------------

            return res
                .status(200)
                .json({
                    success: true,

                    resumeId,

                    fileName:
                        req.file.originalname,

                    message:
                        "Resume processed successfully. You can now ask the AI questions.",

                    preview:
                        resumeText.slice(
                            0,
                            500
                        ),

                    rag: {
                        indexed: true,

                        chunks:
                            ragResult.chunks,

                        indexingTime:
                            ragTime
                    },

                    totalTime:
                        Date.now() -
                        startTime
                })

        } catch (error) {

            console.error(
                "Resume upload error:",
                error
            )

            return res
                .status(400)
                .json({
                    success: false,

                    message:
                        error?.message ||
                        "Unable to process resume."
                })
        }
    }
)


// ======================================================
// SYSTEM PROMPT
// ======================================================

function createResumeSystemPrompt(
    retrievedContext
) {

    return `
You are an AI Resume Analyzer.

You must answer ONLY from the retrieved resume context.

The retrieved context is the only factual source about the candidate.

==================================================
STRICT ANTI-HALLUCINATION RULES
==================================================

Never invent:

- names
- companies
- job titles
- dates
- education
- degrees
- certifications
- skills
- technologies
- tools
- projects
- responsibilities
- achievements
- metrics
- percentages
- team sizes
- customers
- users
- releases
- awards
- locations
- URLs
- employment-gap explanations
- reasons for leaving jobs

If information is not explicitly present in the retrieved context,
do not present it as a candidate fact.

Use wording such as:

"The resume does not provide this information."

"The resume does not document this."

"The available resume information is insufficient to determine this."

==================================================
RAG RULE
==================================================

The context below contains only the passages retrieved for the current
question.

Do not assume that information missing from these passages is absent
from the complete resume.

If the retrieved context is insufficient, say so.

==================================================
SKILLS RULE
==================================================

A skill listed in the Skills section does NOT prove professional usage.

Only say that a technology was professionally used when the retrieved
resume text explicitly connects it to professional work.

==================================================
EMPLOYMENT GAP RULE
==================================================

You may identify an undocumented period between documented jobs.

Do NOT invent the reason.

Never assume:

- unemployment
- education
- freelance work
- consulting
- personal projects
- volunteering
- caregiving
- sabbatical
- startup work

Correct wording:

"The resume documents employment through December 2014 and the next
documented position begins in January 2016. The resume does not document
activity during this period."

For a recommendation:

"If you had relevant activity during this period, consider adding the
accurate information with dates and details."

==================================================
DATE RULE
==================================================

Preserve dates exactly as they appear.

If two dates appear inconsistent, identify the inconsistency and tell
the user to verify the dates.

Do NOT decide which date is correct.

==================================================
METRIC RULE
==================================================

Never change or invent metrics.

If the resume says 45%, use 45%.

If the resume says 95%, use 95%.

Never create new percentages, numbers, customers, users, releases,
test cases, revenue, or project scale.

==================================================
RECOMMENDATION SAFETY RULE
==================================================

Every recommendation must be based on something explicitly visible in
the retrieved resume context.

Never assume that a missing item actually exists.

When recommending additional information, use conditional language.

GOOD:

"If you have relevant activity during this period, consider adding the
accurate activity and dates."

"If Python was used professionally, consider connecting it to the
relevant documented work experience."

"If the certification date is available, consider adding it."

BAD:

"Add your freelance work from 2015."

"Add your Python project."

"Add your AWS experience."

because these assume facts that are not established by the resume.

==================================================
DATE CONSISTENCY RULE
==================================================

If two dates in the retrieved resume appear inconsistent:

1. Identify the inconsistency.
2. Preserve both dates exactly as written.
3. Tell the user to verify the dates.
4. Never decide which date is correct.

For example, if an education entry says the degree was completed in
2008 but an award under that entry says 2012, say:

"The education entry lists a May 2008 completion date and a 2012
Dean's List award. Verify that these dates and their association are
correct."

Do NOT say that either date is definitely wrong.

==================================================
EXPERIENCE-YEARS RULE
==================================================

Do not calculate or state a total number of years of experience unless
the calculation is directly requested by the user.

If the summary says one number and employment dates suggest a different
timeline, describe the discrepancy without inventing a replacement
number.

GOOD:

"The summary states five years of experience, while the documented
employment history spans substantially longer than five years. Verify
the summary's experience figure."

BAD:

"You have 15+ years of experience."

unless the user explicitly asks for a calculation.
==================================================
QUESTION RULE
==================================================

Answer the user's actual question first.

Do not automatically perform a complete resume review.

For a simple factual question:

- answer directly
- strengths must be []
- weaknesses must be []
- recommendations must be []

For a review request:

- provide concise strengths
- provide concise weaknesses
- provide concise recommendations

==================================================
OUTPUT SIZE RULE
==================================================

This is extremely important.

Return a SHORT response.

Maximum:

- answer: 120 words
- strengths: 3 items
- weaknesses: 3 items
- recommendations: 3 items

Each array item should normally be one sentence.

Do NOT produce long explanations.

==================================================
JSON RULE
==================================================

Return ONLY valid JSON.

Do not use markdown fences.

Do not write anything before or after the JSON.

The exact structure is:

{
  "answer": "short answer",
  "strengths": [],
  "weaknesses": [],
  "recommendations": []
}

All array values must be strings.

Do not add any other JSON fields.

==================================================
RETRIEVED RESUME CONTEXT
==================================================

${retrievedContext}

==================================================
END CONTEXT
==================================================
`
}


// ======================================================
// EXTRACT RESPONSE CONTENT
// ======================================================

function extractResponseText(
    content
) {

    if (
        content ===
        null ||
        content ===
        undefined
    ) {
        return ""
    }

    if (
        typeof content ===
        "string"
    ) {
        return content.trim()
    }

    if (
        Array.isArray(content)
    ) {

        return content
            .map(item => {

                if (
                    typeof item ===
                    "string"
                ) {
                    return item
                }

                if (
                    item &&
                    typeof item.text ===
                    "string"
                ) {
                    return item.text
                }

                if (
                    item &&
                    typeof item.content ===
                    "string"
                ) {
                    return item.content
                }

                return ""

            })
            .join("")
            .trim()
    }

    if (
        typeof content ===
        "object"
    ) {

        if (
            typeof content.text ===
            "string"
        ) {
            return content.text.trim()
        }

        if (
            typeof content.content ===
            "string"
        ) {
            return content.content.trim()
        }

        try {

            return JSON.stringify(
                content
            )

        } catch {

            return ""
        }
    }

    return String(
        content
    ).trim()
}


// ======================================================
// REMOVE MARKDOWN JSON FENCES
// ======================================================

function cleanJsonText(
    text
) {

    return String(text)
        .trim()

        .replace(
            /^```json\s*/i,
            ""
        )

        .replace(
            /^```\s*/i,
            ""
        )

        .replace(
            /\s*```$/i,
            ""
        )

        .trim()
}


// ======================================================
// FIND COMPLETE JSON OBJECT
// ======================================================

function findCompleteJsonObject(
    text
) {

    const source =
        cleanJsonText(text)

    let start = -1

    let depth = 0

    let inString = false

    let escaped = false

    for (
        let i = 0;
        i < source.length;
        i++
    ) {

        const char =
            source[i]

        if (
            inString
        ) {

            if (
                escaped
            ) {
                escaped = false
                continue
            }

            if (
                char === "\\"
            ) {
                escaped = true
                continue
            }

            if (
                char === '"'
            ) {
                inString = false
            }

            continue
        }

        if (
            char === '"'
        ) {
            inString = true
            continue
        }

        if (
            char === "{"
        ) {

            if (
                depth === 0
            ) {
                start = i
            }

            depth++

            continue
        }

        if (
            char === "}"
        ) {

            if (
                depth > 0
            ) {
                depth--
            }

            if (
                depth === 0 &&
                start !== -1
            ) {

                return source.slice(
                    start,
                    i + 1
                )
            }
        }
    }

    return null
}


// ======================================================
// JSON PARSER
// ======================================================

function parseAiJson(
    content
) {

    const text =
        extractResponseText(
            content
        )

    if (!text) {

        throw new Error(
            "AI returned an empty response."
        )
    }

    console.log(
        "\n========== RAW AI RESPONSE =========="
    )

    console.log(
        text
    )

    console.log(
        "=====================================\n"
    )


    const cleaned =
        cleanJsonText(
            text
        )


    // ------------------------------------------
    // Direct JSON
    // ------------------------------------------

    try {

        const parsed =
            JSON.parse(
                cleaned
            )

        if (
            parsed &&
            typeof parsed ===
            "object" &&
            !Array.isArray(parsed)
        ) {
            return parsed
        }

    } catch {
        // Continue.
    }


    // ------------------------------------------
    // Find complete JSON object
    // ------------------------------------------

    const jsonObject =
        findCompleteJsonObject(
            cleaned
        )

    if (jsonObject) {

        try {

            const parsed =
                JSON.parse(
                    jsonObject
                )

            if (
                parsed &&
                typeof parsed ===
                "object" &&
                !Array.isArray(parsed)
            ) {
                return parsed
            }

        } catch {
            // Continue.
        }
    }


    throw new Error(
        "AI returned incomplete or invalid JSON."
    )
}


// ======================================================
// NORMALIZE AI RESPONSE
// ======================================================

function normalizeAiResponse(
    parsed
) {

    const answer =
        typeof parsed?.answer ===
        "string"
            ? parsed.answer.trim()
            : ""

    const strengths =
        Array.isArray(
            parsed?.strengths
        )
            ? parsed.strengths
                .filter(
                    item =>
                        typeof item ===
                        "string"
                )
                .map(
                    item =>
                        item.trim()
                )
                .filter(Boolean)
                .slice(0, 3)
            : []

    const weaknesses =
        Array.isArray(
            parsed?.weaknesses
        )
            ? parsed.weaknesses
                .filter(
                    item =>
                        typeof item ===
                        "string"
                )
                .map(
                    item =>
                        item.trim()
                )
                .filter(Boolean)
                .slice(0, 3)
            : []

    const recommendations =
        Array.isArray(
            parsed?.recommendations
        )
            ? parsed.recommendations
                .filter(
                    item =>
                        typeof item ===
                        "string"
                )
                .map(
                    item =>
                        item.trim()
                )
                .filter(Boolean)
                .slice(0, 3)
            : []


    if (!answer) {

        throw new Error(
            "AI response did not contain a valid answer."
        )
    }


    return {
        answer,
        strengths,
        weaknesses,
        recommendations
    }
}


// ======================================================
// AI INVOCATION
// ======================================================

async function invokeResumeAI({
    systemPrompt,
    question
}) {

    // ------------------------------------------
    // First attempt
    // ------------------------------------------

    const firstMessages = [

        new SystemMessage(
            systemPrompt
        ),

        new HumanMessage(
            question
        )
    ]


    try {

        const response =
            await llm.invoke(
                firstMessages
            )

        const parsed =
            parseAiJson(
                response.content
            )

        return normalizeAiResponse(
            parsed
        )

    } catch (firstError) {

        console.warn(
            "First AI response was invalid. Retrying with compact JSON instruction...",
            firstError?.message
        )
    }


    // ------------------------------------------
    // Second attempt
    // ------------------------------------------

    const retryPrompt = `
${systemPrompt}

IMPORTANT RETRY INSTRUCTION:

Your previous response was invalid or incomplete.

Return an even shorter response.

You MUST return one complete valid JSON object.

Do not use markdown.

Do not explain anything outside JSON.

Use this exact structure:

{
  "answer": "maximum 80 words",
  "strengths": ["maximum 3 short items"],
  "weaknesses": ["maximum 3 short items"],
  "recommendations": ["maximum 3 short items"]
}

Keep every item short.

Do not add extra fields.
`


    const retryMessages = [

        new SystemMessage(
            retryPrompt
        ),

        new HumanMessage(
            question
        )
    ]


    const retryResponse =
        await llm.invoke(
            retryMessages
        )

    const retryParsed =
        parseAiJson(
            retryResponse.content
        )

    return normalizeAiResponse(
        retryParsed
    )
}


// ======================================================
// AI ANALYSIS + RAG
// ======================================================

app.post(
    "/ai",

    async (
        req,
        res
    ) => {

        const startTime =
            Date.now()

        try {

            const {
                resumeId,
                input
            } = req.body


            // ------------------------------------------
            // Validate resumeId
            // ------------------------------------------

            if (
                !resumeId ||
                typeof resumeId !==
                "string"
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,

                        message:
                            "resumeId is required."
                    })
            }


            // ------------------------------------------
            // Validate question
            // ------------------------------------------

            if (
                !input ||
                typeof input !==
                "string" ||
                !input.trim()
            ) {

                return res
                    .status(400)
                    .json({
                        success: false,

                        message:
                            "input is required."
                    })
            }


            // ------------------------------------------
            // Get resume session
            // ------------------------------------------

            const resume =
                getResume(
                    resumeId
                )

            if (!resume) {

                return res
                    .status(404)
                    .json({
                        success: false,

                        message:
                            "Resume session expired. Please upload your resume again."
                    })
            }


            const question =
                input.trim()


            // ------------------------------------------
            // RAG RETRIEVAL
            // ------------------------------------------

            const retrievalStart =
                Date.now()

            const retrievedChunks =
                await retrieveResumeContext({
                    resumeId,
                    question,
                    k: 6
                })

            const retrievalTime =
                Date.now() -
                retrievalStart


            console.log(
                `[RAG] Retrieved ${retrievedChunks.length} chunks for resume ${resumeId}`
            )


            // ------------------------------------------
            // No relevant context
            // ------------------------------------------

            if (
                !retrievedChunks.length
            ) {

                const answer =
                    "I could not find enough relevant information in the uploaded resume to answer that question."

                resume.messages.push({
                    role: "user",
                    content: question
                })

                resume.messages.push({
                    role: "assistant",
                    content: answer
                })

                resume.expiresAt =
                    Date.now() +
                    RESUME_TTL

                return res
                    .status(200)
                    .json({

                        success: true,

                        ai:
                            answer,

                        analysis: {
                            strengths: [],
                            weaknesses: [],
                            recommendations: []
                        },

                        meta: {
                            retrievalTime,

                            retrievedChunks:
                                0,

                            aiTime:
                                0,

                            totalTime:
                                Date.now() -
                                startTime
                        }
                    })
            }


            // ------------------------------------------
            // Build retrieved context
            // ------------------------------------------

            const retrievedContext =
                retrievedChunks
                    .map(
                        (
                            chunk,
                            index
                        ) => {

                            return `
--- Resume Chunk ${index + 1} ---
${chunk.content}
--- End Resume Chunk ${index + 1} ---
`
                        }
                    )
                    .join("\n")


            // ------------------------------------------
            // Create system prompt
            // ------------------------------------------

            const systemPrompt =
                createResumeSystemPrompt(
                    retrievedContext
                )


            // ------------------------------------------
            // Invoke AI
            // ------------------------------------------

            const aiStart =
                Date.now()

            const result =
                await invokeResumeAI({
                    systemPrompt,
                    question
                })

            const aiTime =
                Date.now() -
                aiStart


            // ------------------------------------------
            // Save conversation
            // ------------------------------------------

            resume.messages.push({
                role: "user",

                content:
                    question
            })

            resume.messages.push({
                role: "assistant",

                content:
                    result.answer
            })


            // Keep memory bounded.

            if (
                resume.messages.length >
                20
            ) {
                resume.messages =
                    resume.messages.slice(
                        -20
                    )
            }


            // Refresh TTL.

            resume.expiresAt =
                Date.now() +
                RESUME_TTL


            // ------------------------------------------
            // Response
            // ------------------------------------------

            return res
                .status(200)
                .json({

                    success: true,

                    ai:
                        result.answer,

                    analysis: {

                        strengths:
                            result.strengths,

                        weaknesses:
                            result.weaknesses,

                        recommendations:
                            result.recommendations
                    },

                    meta: {

                        retrievalTime,

                        retrievedChunks:
                            retrievedChunks.length,

                        aiTime,

                        totalTime:
                            Date.now() -
                            startTime
                    }
                })

        } catch (error) {

            console.error(
                "Resume AI error:",
                error
            )

            return res
                .status(500)
                .json({

                    success: false,

                    message:
                        error?.message ||
                        "Unable to analyze resume right now."
                })
        }
    }
)


// ======================================================
// DELETE RESUME SESSION
// ======================================================

app.delete(
    "/:resumeId",

    async (
        req,
        res
    ) => {

        const {
            resumeId
        } = req.params

        try {

            await deleteResumeVectors(
                resumeId
            )

        } catch (error) {

            console.error(
                "RAG vector deletion error:",
                error
            )
        }

        resumeStore.delete(
            resumeId
        )

        return res.json({
            success: true
        })
    }
)


// ======================================================
// ERROR HANDLER
// ======================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            error
        )

        if (
            error instanceof
            multer.MulterError
        ) {

            if (
                error.code ===
                "LIMIT_FILE_SIZE"
            ) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        message:
                            "Resume size must be less than 10MB."
                    })
            }
        }


        return res
            .status(400)
            .json({

                success: false,

                message:
                    error?.message ||
                    "Something went wrong."
            })
    }
)


// ======================================================
// START SERVER
// ======================================================

app.listen(
    PORT,

    () => {

        console.log(
            `Resume service running on port ${PORT}`
        )

        connectDB();
    }
)