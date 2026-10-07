import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import llm from "../config/llm.js"


export const resumeAgent = async (resumeText) => {
    const response = await llm.invoke([
        new SystemMessage(`
You are an Expert ATS Resume Analyzer.

Analyze the given resume.

Extract the following information:

- Full Name
- Email
- Phone Number
- Professional Summary
- Technical Skills
- Projects
- Education
- Experience
- Strengths
- Weaknesses
- Missing Skills
- Suggested Job Role
- ATS Score (0-100)
- Recommendations
IMPORTANT RULES:
1. Return ONLY valid JSON.
2. Do not use markdown or explanations.
3. Every field must exist.
4. If information is missing, return an empty string or empty array.
5. Follow the exact JSON structure below.
6. Do not return experience, projects, or education as strings.
7. responsibilities and technologies must be arrays.

Projects, education, and experience MUST be arrays of objects.
Never return strings for these fields.

Weaknesses must not be empty unless the resume genuinely contains no identifiable weaknesses.

Infer reasonable professional weaknesses from missing evidence, for example:
- Limited cloud experience
- No deployment experience shown
- Missing testing experience
- No leadership evidence
- Limited system design exposure
- Missing certifications

Do not invent personal or sensitive weaknesses.
Use professional, resume-related weaknesses only.
Return weaknesses as an array of strings.

Return exactly the following JSON structure:

Response Format:

{
  "name": "",
  "email": "",
  "phone": "",
  "summary": "",
  "skills": [],
  "projects": [
    {
      "name": "",
      "description": "",
      "technologies": []
    }
  ],
  "education": [
    {
      "degree": "",
      "institution": "",
      "duration": "",
      "details": ""
    }
  ],
  "experience": [
    {
      "title": "",
      "company": "",
      "duration": "",
      "location": "",
      "responsibilities": []
    }
  ],
  "strengths": [],
  "weaknesses": [],
  "missingSkills": [],
  "suggestedRole": "",
  "score": 0,
  "recommendations": []
}
`),

    new HumanMessage(resumeText),

    ])
    console.log("AI response type:", typeof response.content)
    console.log("AI response length:", response.content?.length)
    console.log("AI response tail:", response.content?.slice(-500))

    return response.content

}