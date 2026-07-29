/* ==========================================================
   assistant-window.js
   Lanthano Research Assistant
   Window Manager
   ========================================================== */

(() => {

class AssistantWindow {

    constructor() {

        this.root = document.getElementById("lr-ai-root");

        if (!this.root) {

            console.error("AI root not found.");

            return;

        }

        this.window = document.getElementById("lr-ai-window");

        if (!this.window) {

            this.window = document.createElement("div");
            this.window.id = "lr-ai-window";

            this.root.appendChild(this.window);

        }

        this.isOpen = false;

        this.build();

        this.bindEvents();

    }

    build() {

        this.window.innerHTML = `

            <div id="lr-ai-header">

                <div id="lr-ai-title">

                    <img
                        src="${new URL("aiimage.png", import.meta.url).href}"
                        alt="AI">

                    <span>Lanthano Research Assistant</span>

                </div>

                <button
                    id="lr-ai-close"
                    type="button"
                    aria-label="Close">

                    ×

                </button>

            </div>

            <div id="lr-ai-messages">

            </div>

            <div id="lr-ai-input-area">

                <input
                    id="lr-ai-input"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="Ask Lanthano Research Assistant anything...">

                <button
                    id="lr-ai-send"
                    type="button">

                    Send

                </button>

            </div>

        `;

        this.messages =
            this.window.querySelector("#lr-ai-messages");

        this.input =
            this.window.querySelector("#lr-ai-input");

        this.sendButton =
            this.window.querySelector("#lr-ai-send");

        this.closeButton =
            this.window.querySelector("#lr-ai-close");

    }

    bindEvents() {

        this.closeButton.addEventListener(

            "click",

            () => this.close()

        );

        this.sendButton.addEventListener(

            "click",

            () => {

                const text = this.input.value.trim();

                if (!text) return;

                console.log(text);

                this.input.value = "";

            }

        );

        this.input.addEventListener(

            "keydown",

            event => {

                if (event.key === "Escape") {

                    this.close();

                    return;

                }

                if (event.key === "Enter") {

                    event.preventDefault();

                    this.sendButton.click();

                }

            }

        );

    }

    open() {

        if (this.isOpen) return;

        this.window.classList.add("open");

        this.isOpen = true;

        requestAnimationFrame(() => {

            this.input.focus();

        });

    }

    close() {

        if (!this.isOpen) return;

        this.window.classList.remove("open");

        this.isOpen = false;

    }

    toggle() {

        if (this.isOpen) {

            this.close();

        } else {

            this.open();

        }

    }

}

window.AssistantWindowClass = AssistantWindow;

})();
