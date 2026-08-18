const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

const ROOT = path.resolve(__dirname, "..");

const DESCRIPTIONS_FILE = path.join(
    ROOT,
    "descriptions.json"
);

const OUTPUT_FILE = path.join(
    ROOT,
    "page-counts.json"
);


// --------------------------------------------------
// Read descriptions.json
// --------------------------------------------------

if (!fs.existsSync(DESCRIPTIONS_FILE)) {
    console.error("Could not find descriptions.json.");
    process.exit(1);
}

let descriptions;

try {
    descriptions = JSON.parse(
        fs.readFileSync(
            DESCRIPTIONS_FILE,
            "utf8"
        )
    );
} catch (error) {
    console.error(
        "Could not read descriptions.json:"
    );
    console.error(error.message);
    process.exit(1);
}


// --------------------------------------------------
// Find a PDF anywhere in the repository
// --------------------------------------------------

function findFile(directory, filename) {

    const entries = fs.readdirSync(
        directory,
        { withFileTypes: true }
    );

    for (const entry of entries) {

        // Ignore these directories.
        if (
            entry.isDirectory() &&
            (
                entry.name === ".git" ||
                entry.name === "node_modules"
            )
        ) {
            continue;
        }

        const fullPath = path.join(
            directory,
            entry.name
        );

        if (entry.isDirectory()) {

            const result = findFile(
                fullPath,
                filename
            );

            if (result) {
                return result;
            }

        } else if (
            entry.isFile() &&
            entry.name.toLowerCase() ===
            filename.toLowerCase()
        ) {

            return fullPath;
        }
    }

    return null;
}


// --------------------------------------------------
// Count the pages of a PDF
// --------------------------------------------------

async function getPageCount(pdfPath) {

    const pdfBytes = fs.readFileSync(
        pdfPath
    );

    const pdf = await PDFDocument.load(
        pdfBytes,
        {
            ignoreEncryption: true
        }
    );

    return pdf.getPageCount();
}


// --------------------------------------------------
// Build page-counts.json
// --------------------------------------------------

async function buildPageCounts() {

    const pageCounts = {};

    let successful = 0;
    let failed = 0;

    console.log(
        "Building page-counts.json..."
    );

    console.log("");


    for (
        const [key, paper]
        of Object.entries(descriptions)
    ) {

        if (
            !paper ||
            typeof paper !== "object"
        ) {
            console.error(
                `${key}: Invalid entry.`
            );

            failed++;
            continue;
        }


        if (!paper.url) {

            console.error(
                `${key}: No PDF URL specified.`
            );

            failed++;
            continue;
        }


        const pdfFilename = paper.url;

        console.log(
            `Finding: ${pdfFilename}`
        );


        const pdfPath = findFile(
            ROOT,
            path.basename(pdfFilename)
        );


        if (!pdfPath) {

            console.error(
                `  ERROR: PDF not found.`
            );

            failed++;
            continue;
        }


        try {

            const pageCount =
                await getPageCount(
                    pdfPath
                );


            pageCounts[key] =
                pageCount;


            console.log(
                `  Pages: ${pageCount}`
            );

            console.log("");

            successful++;

        } catch (error) {

            console.error(
                `  ERROR reading PDF: ${error.message}`
            );

            console.log("");

            failed++;
        }
    }


    // Sort the entries alphabetically
    // so the generated file stays organized.

    const sortedPageCounts =
        Object.fromEntries(
            Object.entries(pageCounts)
                .sort(([a], [b]) =>
                    a.localeCompare(b)
                )
        );


    // Write the new JSON file.

    fs.writeFileSync(
        OUTPUT_FILE,
        JSON.stringify(
            sortedPageCounts,
            null,
            2
        ) + "\n",
        "utf8"
    );


    console.log(
        "--------------------------------"
    );

    console.log(
        `Papers counted: ${successful}`
    );

    console.log(
        `Papers failed:  ${failed}`
    );

    console.log(
        "Created: page-counts.json"
    );

    console.log(
        "--------------------------------"
    );


    // Do not allow an incomplete list to
    // be treated as a successful build.

    if (failed > 0) {
        process.exit(1);
    }
}


buildPageCounts().catch(error => {

    console.error(
        "Fatal error:"
    );

    console.error(error);

    process.exit(1);
});
