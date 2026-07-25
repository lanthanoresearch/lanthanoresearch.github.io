const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");

const ROOT = __dirname;
const descriptionsPath = path.join(ROOT, "descriptions.json");
const outputPath = path.join(ROOT, "search-index.json");

async function buildSearchIndex() {
    if (!fs.existsSync(descriptionsPath)) {
        throw new Error("descriptions.json not found.");
    }

    const descriptions = JSON.parse(
        fs.readFileSync(descriptionsPath, "utf8")
    );

    const index = [];

    const papers = Object.values(descriptions);

    console.log(`Found ${papers.length} papers.\n`);

    for (const paper of papers) {
        if (!paper.url) {
            console.warn(`Skipping "${paper.title}" (missing URL).`);
            continue;
        }

        const pdfPath = path.join(ROOT, paper.url);

        if (!fs.existsSync(pdfPath)) {
            console.warn(`Missing PDF: ${paper.url}`);
            continue;
        }

        try {
            console.log(`Reading ${paper.url}...`);

            const buffer = fs.readFileSync(pdfPath);
            const data = await pdf(buffer);

            const text = data.text
                .replace(/\r/g, "")
                .replace(/[ \t]+/g, " ")
                .replace(/\n{3,}/g, "\n\n")
                .trim();

            index.push({
                title: paper.title,
                url: paper.url,
                searchText: text
            });

            console.log(`✓ Indexed "${paper.title}"`);
        } catch (err) {
            console.error(`✗ Failed: ${paper.url}`);
            console.error(err.message);
        }
    }

    index.sort((a, b) => a.title.localeCompare(b.title));

    fs.writeFileSync(
        outputPath,
        JSON.stringify(index, null, 2),
        "utf8"
    );

    console.log("");
    console.log("-----------------------------------");
    console.log(`Finished!`);
    console.log(`Indexed ${index.length} papers.`);
    console.log(`Saved search-index.json`);
    console.log("-----------------------------------");
}

buildSearchIndex().catch(err => {
    console.error(err);
    process.exit(1);
});
