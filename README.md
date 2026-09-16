# Movie Batch Downloader

A command-line downloader for movie and TV-series pages that expose downloadable links. It discovers episode or movie links, lets you choose what to download, automates the supported hoster, shows download progress, and keeps media organized for library scanners such as Plex or VLC.

## Features

- Download one episode, selected episodes, or all discovered episodes.
- Process batch downloads sequentially, one file at a time.
- Retry a failed episode up to three times with a short backoff.
- Show a queue dashboard with statuses such as `QUEUED`, `TRY`, `DONE`, `SKIPPED`, `FAILED`, and `CANCELLED`.
- Display a byte-level progress bar while streaming the media file.
- Ask before replacing an existing completed file.
- Remove incomplete files after a failed or cancelled download.
- Organize series by show and season.
- Organize ordinary movies in their own show/movie folder.
- Cancel safely with `Ctrl+C`.

## Requirements

- Python 3.10 or newer
- A working internet connection
- Chromium for Playwright
- Permission to download the media you request

## Setup

From the project directory, create and activate a virtual environment:

```bash
python3 -m venv venv
source venv/bin/activate
```

Install the Python dependencies:

```bash
python -m pip install -r requirements.txt
```

Install the Playwright Chromium browser:

```bash
python -m playwright install chromium
```

On Linux systems that are missing browser libraries, Playwright may also require:

```bash
python -m playwright install-deps chromium
```

## Running

Use the virtual-environment Python executable:

```bash
./venv/bin/python main.py
```

Or activate the environment first and run:

```bash
source venv/bin/activate
python main.py
```

The program asks for a movie or series page URL:

```text
Enter Series/Movie URL: https://thenkiri.com/lioness-s03-complete-tv-series/
```

After the links are found, select everything or enter comma-separated numbers:

```text
Select episodes to download ('all' or numbers e.g. 1,2,4): all
```

Examples:

```text
all
1
1,2,4
```

## Output Layout

TV series are stored using the detected show name and season number:

```text
downloads/
└── Lioness/
    └── Season 03/
        └── Lioness.S03E07.mkv
```

A normal movie is stored in its own folder:

```text
downloads/
└── Inception/
    └── Inception.mkv
```

The program prints the absolute download path when a file completes or when an existing file is found.

## Existing Files

If a completed file already exists, the program reports its location and asks whether it should be replaced:

```text
Already downloaded: /path/to/downloads/Lioness/Season 03/Lioness.S03E07.mkv
Replace this file? [y/N]:
```

- Enter `y` or `yes` to replace it.
- Press Enter or enter `n` to keep it and continue.
- Incomplete files are removed before a fresh attempt.

## Retry and Cancellation

Each episode is attempted up to three times. A failed episode is retried without stopping the rest of the batch. If all attempts fail, it is marked `FAILED` and the next selected item continues.

Press `Ctrl+C` to cancel the active download or the whole batch. The active partial file is removed, completed files are kept, and unfinished queue items are marked `CANCELLED`.

Downloads are sequential rather than concurrent. Selecting `all` does not open 10 or 20 simultaneous downloads; it completes one item before starting the next.

## Website Support

The current implementation is primarily designed for:

- Nkiri pages as the source page where movie or episode links are discovered.
- Downloadwella pages as the supported automated hoster.

The scraper recognizes some links containing `downloadwella`, `pixeldrain`, `mega.nz`, `.mkv`, or `.mp4`, but only Downloadwella has a dedicated browser-download flow. Other websites and hosters may use different page structures, APIs, authentication, timers, or anti-bot systems and may require additional handlers.

The downloader does not improve video quality. It saves the file provided by the source hoster.

## Troubleshooting

### Playwright browser is missing

Run:

```bash
./venv/bin/python -m playwright install chromium
```

### A download fails repeatedly

The hoster may be unavailable, rate-limiting requests, or returning a changed page. Try the episode again later or select a smaller group of episodes.

### The progress bar is slow

The transfer speed is controlled by the source hoster and your connection. Downloads are intentionally sequential to reduce load and keep the queue predictable.

### The page has no downloadable links

The source page may have changed, require a login, or use a hoster that is not implemented yet.

## Project Files

```text
main.py           Downloader application
requirements.txt  Python dependencies
downloads/        Downloaded media and organized folders
README.md         Project documentation
```
