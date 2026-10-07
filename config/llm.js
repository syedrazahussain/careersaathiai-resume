import { ChatGroq } from "@langchain/groq"
import "dotenv/config";

const llm = new ChatGroq({
    // model: "llama-3.3-70b-versatile",
     model: "openai/gpt-oss-120b",
    temperature: 0.2,
    maxTokens: 3000,
    maxRetries: 2,
    
})

export default llm