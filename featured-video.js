/* ---------- Featured Video Loader ---------- */

fetch("featured-video.html")
    .then(response => {
        if(!response.ok){
            throw new Error("Could not load featured video.");
        }

        return response.text();
    })
    .then(html => {

        const container =
            document.getElementById("featuredVideo");

        if(!container){
            return;
        }

        container.innerHTML = html;

    })
    .catch(error => {

        console.error(
            "Featured Video Error:",
            error
        );

    });


/* ---------- Open Video ---------- */

function openFeaturedVideo(){

    const card =
        document.getElementById("featuredVideoCard");

    const video =
        document.getElementById("featuredVideoPlayer");

    if(!card || !video){
        return;
    }

    card.classList.add("expanded");

    video.play().catch(() => {});

}


/* ---------- Close Video ---------- */

function closeFeaturedVideo(event){

    event.stopPropagation();

    const card =
        document.getElementById("featuredVideoCard");

    const video =
        document.getElementById("featuredVideoPlayer");

    if(!card || !video){
        return;
    }

    video.pause();

    video.currentTime = 0;

    card.classList.remove("expanded");

}
