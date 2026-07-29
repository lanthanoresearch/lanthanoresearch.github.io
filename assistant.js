// Prevent duplicates
if (!document.getElementById("lr-ai-button")) {

    const button = document.createElement("button");

    button.id = "lr-ai-button";

    button.innerHTML = `
        <img src="aiimge.png" alt="AI Assistant">
    `;

    button.addEventListener("click", () => {

        alert("Assistant coming soon.");

    });

    document.body.appendChild(button);

}
