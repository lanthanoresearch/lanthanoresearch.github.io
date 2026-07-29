/* ==========================================================
   assistant.js
   Floating AI Button
   ========================================================== */

document.addEventListener("DOMContentLoaded", () => {

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

console.log(img.src);
    img.alt = "AI Assistant";

    button.appendChild(img);

    root.appendChild(button);

   // Window will be added by assistant-window.js
const windowContainer = document.createElement("div");
windowContainer.id = "lr-ai-window";

root.appendChild(windowContainer);

   
    document.body.appendChild(root);

    // ---------------------------------------
    // Hero Detection
    // ---------------------------------------

    const hero = document.querySelector(".hero");

    function updateButtonVisibility() {

        // Every page except homepage
        if (!hero) {

            root.classList.remove("hidden");
            root.classList.add("visible");
            return;

        }

        const rect = hero.getBoundingClientRect();

        // Hero still occupies part of the screen
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
    // Temporary Click Test
    // ---------------------------------------

    button.addEventListener("click", () => {

    if (!window.AssistantWindow) {

        console.error("AssistantWindow has not loaded.");

        return;

    }

    window.AssistantWindow.toggle();

});

});
