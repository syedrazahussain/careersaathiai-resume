import { Document } from "@langchain/core/documents"
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters"
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai"
import { QdrantVectorStore } from "@langchain/qdrant"
import { QdrantClient } from "@qdrant/js-client-rest"


// ======================================================
// CONFIG
// ======================================================

const QDRANT_URL =
    process.env.QDRANT_URL

const QDRANT_API_KEY =
    process.env.QDRANT_API_KEY

const COLLECTION_NAME =
    process.env.QDRANT_COLLECTION_NAME ||
    "resume_analyzer_documents"

const EMBEDDING_MODEL =
    process.env.EMBEDDING_MODEL ||
    "gemini-embedding-001"

const EMBEDDING_DIMENSIONS =
    Number(
        process.env.EMBEDDING_DIMENSIONS ||
        768
    )

const DEFAULT_TOP_K =
    Number(
        process.env.RAG_TOP_K ||
        6
    )

const SCORE_THRESHOLD =
    Number(
        process.env.RAG_SCORE_THRESHOLD ||
        0.30
    )


// ======================================================
// CONFIG VALIDATION
// ======================================================

if (!QDRANT_URL) {
    throw new Error(
        "QDRANT_URL is not configured."
    )
}

if (!QDRANT_API_KEY) {
    throw new Error(
        "QDRANT_API_KEY is not configured."
    )
}

if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
        "GOOGLE_API_KEY is not configured."
    )
}

if (
    !Number.isFinite(
        EMBEDDING_DIMENSIONS
    ) ||
    EMBEDDING_DIMENSIONS <= 0
) {
    throw new Error(
        "EMBEDDING_DIMENSIONS must be a positive number."
    )
}

if (
    !Number.isFinite(
        DEFAULT_TOP_K
    ) ||
    DEFAULT_TOP_K <= 0
) {
    throw new Error(
        "RAG_TOP_K must be a positive number."
    )
}

if (
    !Number.isFinite(
        SCORE_THRESHOLD
    )
) {
    throw new Error(
        "RAG_SCORE_THRESHOLD must be a valid number."
    )
}


// ======================================================
// QDRANT CLIENT
// ======================================================

const qdrantClient =
    new QdrantClient({
        url:
            QDRANT_URL,

        apiKey:
            QDRANT_API_KEY
    })


// ======================================================
// GOOGLE GEMINI EMBEDDINGS
// ======================================================

const embeddings =
    new GoogleGenerativeAIEmbeddings({
        apiKey:
            process.env.GOOGLE_API_KEY,

        model:
            EMBEDDING_MODEL,

        outputDimensionality:
            EMBEDDING_DIMENSIONS
    })


// ======================================================
// TEXT SPLITTER
// ======================================================
//
// Resumes are normally relatively small.
//
// 1200 characters per chunk
// 200 characters overlap
//
// The overlap helps preserve context between
// neighboring resume sections.
//

const textSplitter =
    new RecursiveCharacterTextSplitter({
        chunkSize:
            1200,

        chunkOverlap:
            200,

        separators: [
            "\n\n",
            "\n",
            ". ",
            " ",
            ""
        ]
    })


// ======================================================
// VECTOR STORE CACHE
// ======================================================

let vectorStore =
    null

let vectorStorePromise =
    null

let collectionReadyPromise =
    null


// ======================================================
// ENSURE QDRANT COLLECTION
// ======================================================
//
// This function:
//
// 1. Checks whether the collection exists.
// 2. Creates it if necessary.
// 3. Creates the metadata.resumeId payload index.
//
// The resumeId index is REQUIRED because retrieval uses:
//
// metadata.resumeId = current resume ID
//
// Without this index Qdrant returns:
//
// "Index required but not found for metadata.resumeId"
//
// ======================================================

async function ensureQdrantCollection() {

    if (
        collectionReadyPromise
    ) {
        return collectionReadyPromise
    }

    collectionReadyPromise =
        (async () => {

            console.log(
                `[RAG] Checking Qdrant collection: ${COLLECTION_NAME}`
            )

            const collections =
                await qdrantClient
                    .getCollections()

            const collectionExists =
                collections
                    ?.collections
                    ?.some(
                        collection =>
                            collection.name ===
                            COLLECTION_NAME
                    )

            // --------------------------------------------------
            // CREATE COLLECTION
            // --------------------------------------------------

            if (
                !collectionExists
            ) {

                console.log(
                    `[RAG] Creating Qdrant collection: ${COLLECTION_NAME}`
                )

                await qdrantClient
                    .createCollection(
                        COLLECTION_NAME,
                        {
                            vectors: {
                                size:
                                    EMBEDDING_DIMENSIONS,

                                distance:
                                    "Cosine"
                            }
                        }
                    )

                console.log(
                    `[RAG] Qdrant collection created`
                )
            }

            // --------------------------------------------------
            // CHECK COLLECTION DIMENSION
            // --------------------------------------------------

            const collectionInfo =
                await qdrantClient
                    .getCollection(
                        COLLECTION_NAME
                    )

            const configuredVectorSize =
                collectionInfo
                    ?.config
                    ?.params
                    ?.vectors
                    ?.size

            if (
                configuredVectorSize &&
                Number(
                    configuredVectorSize
                ) !==
                EMBEDDING_DIMENSIONS
            ) {

                throw new Error(
                    [
                        "Qdrant vector dimension mismatch.",
                        `Collection "${COLLECTION_NAME}" uses dimension ${configuredVectorSize}.`,
                        `Application uses dimension ${EMBEDDING_DIMENSIONS}.`,
                        "Use a new collection or recreate the existing collection."
                    ].join(" ")
                )
            }

            // --------------------------------------------------
            // CREATE RESUME ID PAYLOAD INDEX
            // --------------------------------------------------
            //
            // LangChain stores document metadata inside:
            //
            // payload.metadata
            //
            // Therefore the filter path is:
            //
            // metadata.resumeId
            //
            // Qdrant requires an index for this field
            // when using filtered vector search.
            //
            // --------------------------------------------------

            console.log(
                `[RAG] Ensuring payload index: metadata.resumeId`
            )

            try {

                await qdrantClient
                    .createPayloadIndex(
                        COLLECTION_NAME,
                        {
                            field_name:
                                "metadata.resumeId",

                            field_schema:
                                "keyword",

                            wait:
                                true
                        }
                    )

                console.log(
                    `[RAG] Payload index ready: metadata.resumeId`
                )

            } catch (error) {

                const message =
                    String(
                        error?.message ||
                        error?.data?.status?.error ||
                        ""
                    ).toLowerCase()

                /*
                 * Qdrant can report that the index already
                 * exists. That is not an application error.
                 */
                const indexAlreadyExists =
                    message.includes(
                        "already exists"
                    ) ||
                    message.includes(
                        "already exist"
                    )

                if (
                    indexAlreadyExists
                ) {

                    console.log(
                        `[RAG] Payload index already exists: metadata.resumeId`
                    )

                } else {

                    throw error
                }
            }

            console.log(
                `[RAG] Qdrant collection ready: ${COLLECTION_NAME}`
            )

        })()

    try {

        await collectionReadyPromise

    } catch (error) {

        /*
         * Allow another attempt after a failed initialization.
         */
        collectionReadyPromise =
            null

        throw error
    }

    return collectionReadyPromise
}


// ======================================================
// GET VECTOR STORE
// ======================================================

async function getVectorStore() {

    if (
        vectorStore
    ) {
        return vectorStore
    }

    if (
        vectorStorePromise
    ) {
        return vectorStorePromise
    }

    vectorStorePromise =
        (async () => {

            // Make sure the collection and
            // payload index exist first.
            await ensureQdrantCollection()

            const store =
                await QdrantVectorStore
                    .fromExistingCollection(
                        embeddings,
                        {
                            url:
                                QDRANT_URL,

                            apiKey:
                                QDRANT_API_KEY,

                            collectionName:
                                COLLECTION_NAME
                        }
                    )

            vectorStore =
                store

            return store

        })()
        .finally(() => {

            vectorStorePromise =
                null

        })

    return vectorStorePromise
}


// ======================================================
// SPLIT RESUME INTO DOCUMENTS
// ======================================================

async function createResumeDocuments({
    resumeId,
    resumeText
}) {

    // --------------------------------------------------
    // VALIDATE RESUME ID
    // --------------------------------------------------

    if (
        !resumeId ||
        typeof resumeId !== "string"
    ) {

        throw new Error(
            "resumeId is required."
        )
    }

    // --------------------------------------------------
    // VALIDATE RESUME TEXT
    // --------------------------------------------------

    if (
        !resumeText ||
        typeof resumeText !== "string" ||
        !resumeText.trim()
    ) {

        throw new Error(
            "resumeText is required."
        )
    }

    // --------------------------------------------------
    // SPLIT TEXT
    // --------------------------------------------------

    const chunks =
        await textSplitter
            .splitText(
                resumeText.trim()
            )

    if (
        !chunks.length
    ) {

        throw new Error(
            "Unable to create resume chunks."
        )
    }

    // --------------------------------------------------
    // CREATE LANGCHAIN DOCUMENTS
    // --------------------------------------------------

    const documents =
        chunks.map(
            (chunk, index) => {

                return new Document({
                    pageContent:
                        chunk,

                    metadata: {
                        resumeId:

                            resumeId,

                        chunkIndex:
                            index,

                        source:
                            "resume"
                    }
                })
            }
        )

    return documents
}


// ======================================================
// INDEX RESUME
// ======================================================
//
// Called after a resume is uploaded.
//
// Every chunk receives:
//
// metadata.resumeId
//
// This allows many resumes to safely share
// one Qdrant collection.
//

export async function indexResume({
    resumeId,
    resumeText
}) {

    // --------------------------------------------------
    // CREATE CHUNKS
    // --------------------------------------------------

    const documents =
        await createResumeDocuments({
            resumeId,
            resumeText
        })

    // --------------------------------------------------
    // GET VECTOR STORE
    // --------------------------------------------------

    const store =
        await getVectorStore()

    // --------------------------------------------------
    // ADD DOCUMENTS TO QDRANT
    // --------------------------------------------------

    await store.addDocuments(
        documents
    )

    console.log(
        `[RAG] Indexed resume ${resumeId}: ${documents.length} chunks`
    )

    return {
        chunks:
            documents.length
    }
}


// ======================================================
// RETRIEVE RESUME CONTEXT
// ======================================================
//
// This is the main RAG retrieval function.
//
// It:
//
// 1. Converts the question to an embedding.
// 2. Performs semantic search.
// 3. Restricts results to the current resume.
// 4. Applies a similarity threshold.
// 5. Returns only relevant resume chunks.
//

export async function retrieveResumeContext({
    resumeId,
    question,
    k = DEFAULT_TOP_K
}) {

    // --------------------------------------------------
    // VALIDATE RESUME ID
    // --------------------------------------------------

    if (
        !resumeId ||
        typeof resumeId !== "string"
    ) {

        throw new Error(
            "resumeId is required."
        )
    }

    // --------------------------------------------------
    // VALIDATE QUESTION
    // --------------------------------------------------

    if (
        !question ||
        typeof question !== "string" ||
        !question.trim()
    ) {

        return []
    }

    // --------------------------------------------------
    // NORMALIZE K
    // --------------------------------------------------

    const topK =
        Math.max(
            1,
            Math.min(
                Number(k) ||
                    DEFAULT_TOP_K,
                20
            )
        )

    // --------------------------------------------------
    // GET VECTOR STORE
    // --------------------------------------------------

    const store =
        await getVectorStore()

    // --------------------------------------------------
    // QDRANT METADATA FILTER
    // --------------------------------------------------
    //
    // IMPORTANT:
    //
    // LangChain stores our metadata as:
    //
    // payload.metadata.resumeId
    //
    // Therefore:
    //
    // key = metadata.resumeId
    //
    // This guarantees that a question for Resume A
    // cannot retrieve Resume B's chunks.
    //
    // --------------------------------------------------

    const filter = {
        must: [
            {
                key:
                    "metadata.resumeId",

                match: {
                    value:
                        resumeId
                }
            }
        ]
    }

    // --------------------------------------------------
    // SEMANTIC SEARCH
    // --------------------------------------------------

    const results =
        await store
            .similaritySearchWithScore(
                question.trim(),
                topK,
                filter
            )

    // --------------------------------------------------
    // NORMALIZE RESULTS
    // --------------------------------------------------

    const normalized =
        results
            .map(
                ([document, score]) => {

                    return {
                        content:
                            document
                                ?.pageContent,

                        score,

                        chunkIndex:
                            document
                                ?.metadata
                                ?.chunkIndex,

                        resumeId:
                            document
                                ?.metadata
                                ?.resumeId
                    }
                }
            )
            .filter(
                result => {

                    if (
                        typeof result.content !==
                        "string"
                    ) {
                        return false
                    }

                    if (
                        !result.content.trim()
                    ) {
                        return false
                    }

                    /*
                     * Qdrant cosine similarity:
                     *
                     * higher = more similar
                     *
                     * Only reject when a numeric score
                     * is available and below threshold.
                     */
                    if (
                        typeof result.score ===
                            "number" &&
                        result.score <
                            SCORE_THRESHOLD
                    ) {
                        return false
                    }

                    /*
                     * Extra safety check.
                     *
                     * Even though the Qdrant filter already
                     * restricts this, don't return a document
                     * whose metadata does not match.
                     */
                    if (
                        result.resumeId !==
                        resumeId
                    ) {
                        return false
                    }

                    return true
                }
            )

    console.log(
        `[RAG] Retrieved ${normalized.length} chunks for resume ${resumeId}`
    )

    return normalized
}


// ======================================================
// BUILD RAG CONTEXT
// ======================================================
//
// Converts retrieved chunks into a compact context
// that can be inserted into the LLM prompt.
//

export function buildResumeContext(
    retrievedChunks
) {

    if (
        !Array.isArray(
            retrievedChunks
        ) ||
        !retrievedChunks.length
    ) {

        return ""
    }

    return retrievedChunks
        .map(
            (chunk, index) => {

                const chunkNumber =
                    Number.isInteger(
                        chunk.chunkIndex
                    )
                        ? chunk.chunkIndex
                        : index

                return [
                    `[Resume Chunk ${chunkNumber}]`,
                    chunk.content.trim()
                ].join("\n")
            }
        )
        .join("\n\n")
}


// ======================================================
// GET RAG CONTEXT
// ======================================================
//
// Convenience function.
//
// Instead of calling:
//
// retrieveResumeContext()
// buildResumeContext()
//
// separately, the AI route can simply call:
//
// getResumeContext()
//
// ======================================================

export async function getResumeContext({
    resumeId,
    question,
    k = DEFAULT_TOP_K
}) {

    const chunks =
        await retrieveResumeContext({
            resumeId,
            question,
            k
        })

    const context =
        buildResumeContext(
            chunks
        )

    return {
        chunks,
        context,
        count:
            chunks.length
    }
}


// ======================================================
// DELETE RESUME VECTORS
// ======================================================
//
// Deletes ONLY vectors belonging to the supplied resumeId.
//
// This is important when a resume is deleted.
//
// Other resumes remain untouched.
//

export async function deleteResumeVectors(
    resumeId
) {

    // --------------------------------------------------
    // VALIDATE
    // --------------------------------------------------

    if (
        !resumeId ||
        typeof resumeId !== "string"
    ) {

        return
    }

    // --------------------------------------------------
    // MAKE SURE COLLECTION EXISTS
    // --------------------------------------------------

    try {

        await ensureQdrantCollection()

    } catch (error) {

        const message =
            String(
                error?.message ||
                ""
            ).toLowerCase()

        if (
            message.includes(
                "not found"
            ) ||
            message.includes(
                "does not exist"
            )
        ) {

            return
        }

        throw error
    }

    // --------------------------------------------------
    // DELETE USING PAYLOAD FILTER
    // --------------------------------------------------

    try {

        await qdrantClient
            .delete(
                COLLECTION_NAME,
                {
                    filter: {
                        must: [
                            {
                                key:
                                    "metadata.resumeId",

                                match: {
                                    value:
                                        resumeId
                                }
                            }
                        ]
                    },

                    wait:
                        true
                }
            )

        console.log(
            `[RAG] Deleted vectors for resume ${resumeId}`
        )

    } catch (error) {

        const message =
            String(
                error?.message ||
                error?.data?.status?.error ||
                ""
            ).toLowerCase()

        if (
            message.includes(
                "not found"
            ) ||
            message.includes(
                "does not exist"
            )
        ) {

            return
        }

        throw error
    }
}


// ======================================================
// RAG HEALTH CHECK
// ======================================================
//
// Useful for startup/debugging.
//
// Returns basic Qdrant configuration without
// exposing API keys.
//

export async function checkRagHealth() {

    try {

        await ensureQdrantCollection()

        const collection =
            await qdrantClient
                .getCollection(
                    COLLECTION_NAME
                )

        return {
            ok:
                true,

            collection:
                COLLECTION_NAME,

            embeddingModel:
                EMBEDDING_MODEL,

            embeddingDimensions:
                EMBEDDING_DIMENSIONS,

            vectorCount:
                collection
                    ?.points_count ??
                null
        }

    } catch (error) {

        return {
            ok:
                false,

            collection:
                COLLECTION_NAME,

            error:
                error?.message ||
                "Unknown RAG error"
        }
    }
}


// ======================================================
// EXPORT CONFIG
// ======================================================
//
// These are useful if index.js needs to display
// RAG configuration.
//

export const ragConfig = {
    collectionName:
        COLLECTION_NAME,

    embeddingModel:
        EMBEDDING_MODEL,

    embeddingDimensions:
        EMBEDDING_DIMENSIONS,

    topK:
        DEFAULT_TOP_K,

    scoreThreshold:
        SCORE_THRESHOLD
}