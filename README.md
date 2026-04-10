# Next Movie Picker

Chrome extension (Manifest V3) that helps you pick what to watch next. You start with your **top 3 favourite movies**, then get **one recommendation at a time** and can **rate each pick from 1–5** to steer future suggestions.

Data and ratings stay in the extension; recommendations use [The Movie Database (TMDB)](https://www.themoviedb.org/) API.

## Requirements

- [Google Chrome](https://www.google.com/chrome/) (or another Chromium browser that supports unpacked extensions)
- A free TMDB **API v3 key** from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)

## Install (developer / unpacked)

1. Clone or download this repo.
2. Open Chrome → **Extensions** → enable **Developer mode**.
3. Click **Load unpacked** and choose the `movie-rec-extension` folder (the one containing `manifest.json`).
4. Click the extension icon → **API key** (or open **Extension options**) and paste your TMDB key, then **Save**.

## Usage

1. Add your TMDB key in settings (stored locally on your device only).
2. In the popup, search and select your three seed films.
3. Browse recommendations one at a time and rate them to refine what you see next.

## Privacy

Your TMDB API key and extension data are kept in `chrome.storage` on your machine. This project does not send your key or ratings to any server other than TMDB when fetching movie data.

## Repository

[github.com/gwmayor2000/movie-rec-extension](https://github.com/gwmayor2000/movie-rec-extension)

## License

No license file is included; add one if you want to specify terms for reuse.
