/* ==========================================================
   assistant.js
   Lanthano Research Assistant — Floating Button

   Creates the floating button + its root container, hides it
   while the hero banner is in view (fading back in once the
   visitor scrolls past it), and hands off to AssistantWindow
   (assistant-window.js) to actually open the chat.
   ========================================================== */

document.addEventListener("DOMContentLoaded", () => {

    const ENABLE_AI_BUTTON = true;

    if (!ENABLE_AI_BUTTON) return;

    // ---------------------------------------
    // Create root + button
    // ---------------------------------------

    const root = document.createElement("div");
    root.id = "lr-ai-root";
    root.className = "hidden";

    const button = document.createElement("button");
    button.id = "lr-ai-button";
    button.type = "button";
    button.setAttribute("aria-label", "AI Assistant");

    const img = document.createElement("img");
    img.src = new URL("aiimage.png", import.meta.url).href;
    img.alt = "AI Assistant";
    img.onerror = () => console.error("Lanthano Assistant: failed to load aiimage.png");

    button.appendChild(img);
    root.appendChild(button);
    document.body.appendChild(root);

    // ---------------------------------------
    // Create the assistant window
    // ---------------------------------------

    if (window.AssistantWindowClass) {
        window.AssistantWindow = new window.AssistantWindowClass();
    } else {
        console.error("Lanthano Assistant: AssistantWindowClass is not available — check that assistant-window.js loaded.");
    }

    // ---------------------------------------
    // Hide the button (and, if open, the whole
    // window) while the hero banner is in view
    // ---------------------------------------

    const hero = document.querySelector(".hero");

    function updateButtonVisibility() {
        if (!hero) {
            root.classList.remove("hidden");
            root.classList.add("visible");
            return;
        }

        const heroStillInView = hero.getBoundingClientRect().bottom > 100;

        root.classList.toggle("hidden", heroStillInView);
        root.classList.toggle("visible", !heroStillInView);
    }

    window.addEventListener("scroll", updateButtonVisibility, { passive: true });
    window.addEventListener("resize", updateButtonVisibility);
    updateButtonVisibility();

    // ---------------------------------------
    // Open/close on click
    // ---------------------------------------

    button.addEventListener("click", () => {
        if (!window.AssistantWindow) {
            console.error("Lanthano Assistant: AssistantWindow has not loaded.");
            return;
        }
        window.AssistantWindow.toggle();
    });

});
