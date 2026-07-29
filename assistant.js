/* ==========================================================
   assistant.js
   Floating AI Button
   ========================================================== */

async function browserAISupported() {

    try {

        // New Chrome Prompt API
        if ("LanguageModel" in window) {

            const availability = await LanguageModel.availability();

            return (
                availability === "available" ||
                availability === "downloadable" ||
                availability === "downloading"
            );

        }

        // Older Chrome AI API
        if (window.ai?.languageModel) {

            return true;

        }

    } catch (error) {

        console.error("Browser AI detection failed:", error);

    }

    return false;

}

document.addEventListener("DOMContentLoaded", async () => {

    // ---------------------------------------
    // Browser AI Check
    // ---------------------------------------

    if (!(await browserAISupported())) {

        console.log("Browser AI not supported.");

        return;

    }

    console.log("Browser AI supported.");

    // ---------------------------------------
    // Create Root
    // ---------------------------------------

    const root = document.createElement("div");
    root.id = "lr-ai-root";
    root.className = "hidden";

    // ---------------------------------------
    // Create Button
    // ---------------------------------------

    const button = document.createElement("button");
    button.id = "lr-ai-button";
    button.type = "button";
    button.setAttribute("aria-label", "AI Assistant");

    const img = document.createElement("img");

    img.src = new URL("aiimage.png", import.meta.url).href;

    img.alt = "AI Assistant";

    img.onerror = () => {

        console.error("Failed to load aiimage.png");

    };

    button.appendChild(img);

    root.appendChild(button);

    document.body.appendChild(root);

    // ---------------------------------------
    // Create Assistant Window
    // ---------------------------------------

    if (window.AssistantWindowClass) {

        window.AssistantWindow = new window.AssistantWindowClass();

    } else {

        console.error("AssistantWindowClass is not available.");

    }

    // ---------------------------------------
    // Hero Detection
    // ---------------------------------------

    const hero = document.querySelector(".hero");

    function updateButtonVisibility() {

        if (!hero) {

            root.classList.remove("hidden");
            root.classList.add("visible");

            return;

        }

        const rect = hero.getBoundingClientRect();

        if (rect.bottom > 100) {

            root.classList.remove("visible");
            root.classList.add("hidden");

        } else {

            root.classList.remove("hidden");
            root.classList.add("visible");

        }

    }

    window.addEventListener("scroll", updateButtonVisibility, {
        passive: true
    });

    window.addEventListener("resize", updateButtonVisibility);

    updateButtonVisibility();

    // ---------------------------------------
    // Open Assistant
    // ---------------------------------------

    button.addEventListener("click", () => {

        if (!window.AssistantWindow) {

            console.error("AssistantWindow has not loaded.");

            return;

        }

        window.AssistantWindow.toggle();

    });

});
