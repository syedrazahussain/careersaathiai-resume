import redis from '../shared/redis/redis.js'
import { resumeAgent } from "../agents/resume.agent.js";
import extractText from "../config/pdf.js";
import Resume from "../models/resume.model.js";
import fs from "fs"

export const uploadResume = async (req, res) => {
    const file = req.file;

    try {
        if (!file) {
            return res.status(400).json({
                success: false,
                message: "Resume PDF is required",
            });
        }

        const userId = req.headers["x-user-id"];

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "UserId is required",
            });
        }

        const resumeText = await extractText(file.path);

        const aiResponse = await resumeAgent(resumeText);

        const isObject = (value) =>
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);

        const normalizeResumeData = (data) => ({
            ...data,

            skills: Array.isArray(data.skills) ? data.skills : [],
            strengths: Array.isArray(data.strengths) ? data.strengths : [],
            weaknesses: Array.isArray(data.weaknesses)
                ? data.weaknesses
                : [],
            missingSkills: Array.isArray(data.missingSkills)
                ? data.missingSkills
                : [],
            recommendations: Array.isArray(data.recommendations)
                ? data.recommendations
                : [],

            education: Array.isArray(data.education)
                ? data.education.filter(isObject)
                : [],

            projects: Array.isArray(data.projects)
                ? data.projects.filter(isObject)
                : [],

            experience: Array.isArray(data.experience)
                ? data.experience.filter(isObject)
                : [],
        });
        const parsedResumeData = JSON.parse(aiResponse);

        

        const resumeData = normalizeResumeData(parsedResumeData);

        

        let resume = await Resume.findOne({ userId });

        if (resume) {
            Object.assign(resume, {
                ...resumeData,
                extractedText: resumeText,
            });

            await resume.save();
        } else {
            resume = await Resume.create({
                userId,
                extractedText: resumeText,
                ...resumeData,
            });
        }

        await redis.set(
            `resume:${userId}`,
            JSON.stringify(resume)
        );

        await fs.promises.unlink(file.path).catch(() => { });

        return res.status(200).json({
            success: true,
            message: "Resume analyzed successfully",
            data: resume,
        });
    } catch (error) {
        console.error("Upload resume error:", error);

        if (file?.path) {
            await fs.promises.unlink(file.path).catch(() => { });
        }

        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};
export const getResume = async (req, res) => {
    try {
        const userId = req.headers["x-user-id"];
        const cache = await redis.get(`resume:${userId}`)

        if (cache) {
            return res.status(200).json({
                success: true,
                source: "redis",
                data: JSON.parse(cache)
            })
        }

        const resume = await Resume.findOne({
            userId
        })

        if (!resume) {
            return res.status(404).json({
                success: false,
                message: "resume not found"
            })
        }

        await redis.set(`resume:${userId}`, JSON.stringify(resume))
        return res.status(200).json({
            success: true,
            source: "mongodb",
            data: resume
        })
    } catch (error) {
        console.log(error)
        return res.status(500).json({
            success: false,
            message: error.message,

        })

    }

}