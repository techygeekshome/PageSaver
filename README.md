# Page Saver: Image and Video Downloader

Save every image on a web page at the biggest size the site has, plus its videos, in one ZIP file. Streamed videos (HLS and DASH) are downloaded piece by piece and joined into one normal MP4, with no extra app to install.

**Download and full guide:** https://techygeekshome.info/browser-extensions/page-saver/

## What it does

- **Every image on the page**, including ones that only load as you scroll, background pictures and gallery links.
- **The biggest size the site has.** Page Saver swaps thumbnails for the original where the site makes that possible (WordPress, Shopify, Wikipedia, BBC, Pinterest, X, Google, Amazon, eBay, Etsy, Cloudinary and image servers that size pictures in the address), then checks the sizes and keeps the bigger copy.
- **Videos**: normal video files, and streamed video (HLS `.m3u8` and DASH `.mpd`) joined into one MP4 at the best quality, with the sound.
- **Removes duplicates**, keeping the biggest copy, and hides tiny icons with a size filter.
- **You choose what goes in**: a preview grid with tick boxes, an Images and Videos switch, and a Save button on each video.
- **One ZIP download**, with images and videos in their own folders.

## What it won't do

- **YouTube** is not supported.
- **Copy-protected video** (DRM, such as Netflix, Disney+ or Prime Video), encrypted streams and **live broadcasts** are skipped.

## Install

**Microsoft Edge:** an Edge Add-ons listing is in review. Until then, use the download below.

Pick the download for your browser from the [latest release](https://github.com/techygeekshome/PageSaver/releases/latest).

| Browser | Download |
|---|---|
| Chrome, Brave, Opera, Vivaldi | `PageSaver-chrome.zip` |
| Microsoft Edge | `PageSaver-edge.zip` |
| Firefox (142 or newer) | `PageSaver-firefox.zip` |

`PageSaver.zip` is the same package as the Chrome and Edge downloads.

### Chrome, Edge, Brave, Opera and Vivaldi

1. Unzip the download somewhere you'll keep it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the `page-saver` folder.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and pick `PageSaver-firefox.zip`.

Firefox removes temporary add-ons when it closes.

### Build it yourself

The code in this repo is the Chromium version. `manifest.firefox.json` is the Firefox manifest. Run `./build.sh` to make every package in `dist/`.

## Use

1. Open any web page and let it load. For a video, start it playing for a moment so the page loads it.
2. Click the Page Saver icon. It scrolls the page so every picture loads, then opens a results tab.
3. Untick anything you don't want, or use **Save this video** to save one video on its own.
4. Click **Download ZIP**.

## How it works

- `scan.js` looks through the page you are on for images and videos and works out where the full-size copies are.
- `background.js` notes the video files and stream playlists the tab loads, so streamed video is found even when the page only shows a player.
- `streams.js` reads HLS and DASH playlists, picks the best quality and downloads the pieces.
- `mp4.js` joins the pieces into one normal MP4 (audio and video together, playable and seekable in any player). Older HLS streams in `.ts` pieces are converted first with [mux.js](https://github.com/videojs/mux.js) (Apache-2.0, `lib-mux-mp4.js`).
- Downloads are sent with the page as the referrer, as the page's own requests would be, because many sites refuse pictures and videos requested from anywhere else.

## Privacy

Page Saver only works on the page you click it on. It downloads straight from the website's own servers to your computer, with no website in the middle. It has no account, no analytics and sends nothing anywhere else. The only things it stores are your filter settings and the list of videos the current tab has loaded, on your own computer.

## Licence

GPL-3.0. Free for everyone, including commercial use. `lib-mux-mp4.js` is mux.js by Brightcove, under the Apache-2.0 licence (`LICENSE-mux.js.txt`).

Page Saver is an independent tool made by [TechyGeeksHome](https://techygeekshome.info). The pictures and videos you save still belong to the people who made them. Only save what you have the right to keep.
