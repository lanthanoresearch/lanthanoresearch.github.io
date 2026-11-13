/* Hands one finished video to the browser's own player.

   The helper page (video.html opened for "Open in Browser") downloads a video that
   lives on the video server, stores it in the browser's cache, and sends the browser
   to an address under /__rawvideo/. This worker answers that address from the cache,
   including the "give me this part" requests a video player makes when it plays and
   skips around. (A video held only by the page that made it stops loading as soon as
   that page is left; this is held by the browser instead.)

   It answers nothing else: its reach is only /__rawvideo/. */

const CACHE = "lt-raw-video";

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", event => {

    const url = new URL(event.request.url);

    if(!url.pathname.includes("/__rawvideo/")) return;

    event.respondWith(serve(event.request, url));
});

async function serve(request, url){

    const cache = await caches.open(CACHE);

    const hit = await cache.match(url.origin + url.pathname);

    if(!hit) return new Response("Not found", { status: 404 });

    const blob = await hit.blob();
    const size = blob.size;
    const type = hit.headers.get("Content-Type") || "video/mp4";

    const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };

    const asked = request.headers.get("Range");
    const m = asked && /^bytes=(\d*)-(\d*)$/.exec(asked.trim());

    if(m && (m[1] !== "" || m[2] !== "")){

        let start, end;

        if(m[1] === ""){
            start = Math.max(0, size - Number(m[2]));
            end = size - 1;
        }else{
            start = Number(m[1]);
            end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        }

        if(start >= size || start > end){
            return new Response(null, { status: 416, headers: Object.assign({ "Content-Range": "bytes */" + size }, base) });
        }

        return new Response(blob.slice(start, end + 1, type), {
            status: 206,
            headers: Object.assign({ "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": String(end - start + 1) }, base)
        });
    }

    return new Response(blob, { status: 200, headers: Object.assign({ "Content-Length": String(size) }, base) });
}
