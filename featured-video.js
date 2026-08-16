/* ---------- Featured Video Loader ---------- */

fetch("featured-video.html")
    .then(response => {

        if(!response.ok){
            throw new Error(
                "Could not load featured-video.html"
            );
        }

        return response.text();

    })
    .then(html => {

        const container =
            document.getElementById("featuredVideo");

        if(!container){
            console.error(
                "Element #featuredVideo was not found."
            );

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

    document.body.style.overflow = "hidden";

    video.currentTime = 0;

    video.play().catch(() => {});

}


/* ---------- Close Video ---------- */

function closeFeaturedVideo(event){

    if(event){
        event.stopPropagation();
    }

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

    document.body.style.overflow = "";
}


/* ---------- Escape Key ---------- */

document.addEventListener(
    "keydown",
    function(event){

        if(event.key !== "Escape"){
            return;
        }

        const card =
            document.getElementById("featuredVideoCard");

        if(
            card &&
            card.classList.contains("expanded")
        ){

            closeFeaturedVideo();

        }

    }
);
