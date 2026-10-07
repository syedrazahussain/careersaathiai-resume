import fs from "fs"
import { PDFParse } from "pdf-parse"

const extractText = async (filePath) => {

    try {

        if (!filePath) {
            throw new Error("PDF file path is missing")
        }

        if (!fs.existsSync(filePath)) {
            throw new Error("PDF file does not exist")
        }

        const buffer = await fs.promises.readFile(filePath)

        if (!buffer.length) {
            throw new Error("PDF file is empty")
        }

        // Basic PDF signature check
        const header = buffer
            .subarray(0, 5)
            .toString()

        if (header !== "%PDF-") {
            throw new Error("Uploaded file is not a valid PDF")
        }

        const pdf = new PDFParse({
            data: buffer
        })

        const result = await pdf.getText()

        await pdf.destroy()

        if (!result?.text?.trim()) {
            throw new Error(
                "Unable to extract text from this PDF"
            )
        }

        return result.text.trim()

    } catch (error) {

        console.error(
            "PDF text extraction error:",
            error
        )

        throw new Error(
            `Unable to read PDF: ${error.message}`
        )
    }
}

export default extractText
