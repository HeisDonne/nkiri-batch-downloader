import asyncio
import os
import re
from urllib.parse import urljoin
from bs4 import BeautifulSoup
import httpx
from playwright.async_api import async_playwright
from tqdm import tqdm

DOWNLOAD_DIR = "./downloads"
MAX_RETRIES = 3
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def sanitize_filename(filename: str) -> str:
    """Removes invalid OS filename characters."""
    return re.sub(r'[\\/*?:"<>|]', "", filename).strip().replace(" ", "_")


def get_show_name(html_content: str, source_url: str) -> str:
    """Gets a stable show name from the page title or URL slug."""
    soup = BeautifulSoup(html_content, "html.parser")
    title = soup.find("h1") or soup.find("title")
    raw_name = title.get_text(" ", strip=True) if title else ""
    if not raw_name:
        raw_name = source_url.rstrip("/").rsplit("/", 1)[-1]

    raw_name = re.sub(r"\s*\(?\d{4}\)?", "", raw_name)
    raw_name = re.sub(
        r"[-_ ]+s\d+(?:[-_ ]+(?:complete|tv|series|season))*.?",
        " ",
        raw_name,
        flags=re.IGNORECASE,
    )
    raw_name = re.sub(
        r"[-_ ]+(?:complete|tv|series|season)[-_ ]*.*$",
        " ",
        raw_name,
        flags=re.IGNORECASE,
    )
    return sanitize_filename(raw_name) or "Downloads"


def get_episode_path(show_name: str, episode_title: str) -> str:
    """Builds a Plex-friendly show/season/episode path."""
    episode_match = re.search(r"S(\d+)E(\d+)", episode_title, re.IGNORECASE)
    if episode_match:
        season_number = int(episode_match.group(1))
        episode_name = f"{show_name}.S{season_number:02d}E{int(episode_match.group(2)):02d}.mkv"
        season_folder = f"Season {season_number:02d}"
        return os.path.join(DOWNLOAD_DIR, show_name, season_folder, episode_name)

    if episode_title.lower().startswith("episode_"):
        episode_name = f"{show_name}.mkv"
    else:
        episode_name = f"{show_name}.{sanitize_filename(episode_title)}.mkv"
    return os.path.join(DOWNLOAD_DIR, show_name, episode_name)


def render_dashboard(statuses: list[dict], active_index: int | None = None) -> None:
    """Renders the batch queue in one compact terminal dashboard."""
    print("\033[2J\033[H", end="")
    print("Movie Batch Download")
    print("=" * 54)
    for index, item in enumerate(statuses, 1):
        marker = ">" if index - 1 == active_index else " "
        print(f"{marker} [{item['status']:<9}] {index:>2}. {item['title']}")
    print("=" * 54)


async def download_episode_with_retries(
    playwright, episode: dict, output_path: str, status: dict, status_index: int, statuses: list[dict]
) -> bool:
    """Retries one episode without interrupting the rest of the batch."""
    for attempt in range(1, MAX_RETRIES + 1):
        status["status"] = f"TRY {attempt}/{MAX_RETRIES}"
        render_dashboard(statuses, status_index)
        success = await download_with_playwright(
            playwright, episode["url"], output_path
        )
        if success:
            status["status"] = "DONE"
            render_dashboard(statuses)
            return True

        if attempt < MAX_RETRIES:
            status["status"] = f"RETRY {attempt + 1}/{MAX_RETRIES}"
            render_dashboard(statuses, status_index)
            await asyncio.sleep(2 ** (attempt - 1) * 5)

    status["status"] = "FAILED"
    render_dashboard(statuses)
    return False


def fetch_html(url: str) -> str:
    """Fetches raw HTML from main site page."""
    with httpx.Client(headers=HEADERS, follow_redirects=True, timeout=15.0) as client:
        response = client.get(url)
        response.raise_for_status()
        return response.text


def extract_episode_links(html_content: str, base_url: str) -> list[dict]:
    """Extracts episode host links from Nkiri while skipping menu items."""
    soup = BeautifulSoup(html_content, "html.parser")
    episodes = []

    for a_tag in soup.find_all("a", href=True):
        link = str(a_tag["href"]).strip()
        text = a_tag.text.strip()

        # Skip site navigation links
        if any(
            ignore in text.lower()
            for ignore in [
                "bollywood",
                "korean",
                "philippine",
                "how to download",
                "can't download",
            ]
        ):
            continue

        # Look for video host links or raw video extensions
        if any(
            indicator in link.lower()
            for indicator in [
                "downloadwella",
                "pixeldrain",
                "mega.nz",
                ".mkv",
                ".mp4",
            ]
        ):
            ep_match = re.search(r"S\d+E\d+", link, re.IGNORECASE)
            title_label = (
                ep_match.group(0)
                if ep_match
                else f"Episode_{len(episodes) + 1}"
            )
            full_url = str(urljoin(base_url, link))
            episodes.append({"title": title_label, "url": full_url})

    return episodes


async def download_with_playwright(
    playwright, host_url: str, output_path: str
) -> bool:
    print(f"\n[Browser Engine] Opening hoster page: {host_url}")

    browser = await playwright.chromium.launch(
        headless=True,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )

    context = await browser.new_context(
        accept_downloads=True, user_agent=HEADERS["User-Agent"]
    )
    page = await context.new_page()

    try:
        await page.goto(host_url, wait_until="domcontentloaded", timeout=30000)

        # Step 1: submit whichever first-stage control the hoster exposes.
        stage1_selectors = (
            "#downloadbtn",
            "input[value*='Free Download']",
            "button:has-text('Free Download')",
            "input[name='method_free']",
        )
        for selector in stage1_selectors:
            candidate = page.locator(selector).first
            if await candidate.count() and await candidate.is_visible():
                print("   [Step 1] Submitting hoster download form...")
                await candidate.click()
                await page.wait_for_timeout(2000)
                break

        # Step 2: Wait until Downloadwella unlocks the download button
        print("   [Step 2] Waiting for server timer & button unlock...")
        
        # Downloadwella now creates a Start download link after the first click.
        download_btn = page.locator(
            "a[href*='/d/'], a:has-text('Start download'), #btn_download, "
            "input[value*='Direct Download'], input[value*='Download File']"
        ).first
        
        # Explicitly wait for the element to become visible on page (up to 20 seconds)
        await download_btn.wait_for(state="visible", timeout=20000)
        print("   [Step 3] Download button unlocked! Triggering browser download event...")

        # Current Downloadwella pages expose the actual media URL as a link.
        # Streaming it ourselves allows tqdm to report byte-level progress.
        media_url = await download_btn.get_attribute("href")
        if media_url:
            media_url = str(urljoin(page.url, media_url))
            cookies = {
                cookie["name"]: cookie["value"]
                for cookie in await context.cookies()
            }
            print("   [Step 3] Direct media link found. Downloading with progress...")
            success = await stream_direct_media(media_url, output_path, cookies)
            await browser.close()
            return success

        # Fallback for older hoster pages that trigger a native browser download.
        async with page.expect_download(timeout=60000) as download_info:
            await download_btn.click()

        download = await download_info.value
        await download.save_as(output_path)

        file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        if file_size_mb < 1.0:
            print(f"   [!] File size too small ({file_size_mb:.2f} MB). Hoster served error page.")
            await browser.close()
            return False

        print(f"   [Success] Download complete! File size: {file_size_mb:.2f} MB")
        await browser.close()
        return True

    except Exception as e:
        print(f"   [!] Hoster automation failed: {e}")
        await browser.close()
        return False
    except asyncio.CancelledError:
        await browser.close()
        raise


 

async def stream_direct_media(url: str, output_path: str, cookies: dict) -> bool:
    """Streams video file with progress bar using captured session context."""
    headers = {
        "User-Agent": HEADERS["User-Agent"],
        "Referer": "https://downloadwella.com/",
    }

    try:
        async with httpx.AsyncClient(
            headers=headers, cookies=cookies, follow_redirects=True, timeout=120.0
        ) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total_size = int(response.headers.get("Content-Length", 0))

                with open(output_path, "wb") as file, tqdm(
                    total=total_size,
                    unit="B",
                    unit_scale=True,
                    unit_divisor=1024,
                    desc=os.path.basename(output_path)[:20],
                ) as progress_bar:
                    async for chunk in response.aiter_bytes(chunk_size=16384):
                        file.write(chunk)
                        progress_bar.update(len(chunk))

        file_size_mb = os.path.getsize(output_path) / (1024 * 1024)
        if file_size_mb < 1.0:  # If downloaded file is < 1MB, it's an error page
            print(f"   [!] Downloaded file is too small ({file_size_mb:.2f} MB). Host rejected session.")
            return False

        print(f"   [Success] Download complete! Size: {file_size_mb:.2f} MB")
        return True

    except Exception as e:
        if os.path.exists(output_path):
            os.remove(output_path)
        print(f"   [!] Direct stream error: {e}")
        return False
    except asyncio.CancelledError:
        if os.path.exists(output_path):
            os.remove(output_path)
        raise



async def stream_file_with_httpx(url: str, output_path: str) -> bool:
    """Fast streaming downloader used once the direct media URL is captured."""
    try:
        async with httpx.AsyncClient(headers=HEADERS, follow_redirects=True, timeout=60.0) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total_size = int(response.headers.get("Content-Length", 0))

                with open(output_path, "wb") as file, tqdm(
                    total=total_size,
                    unit="B",
                    unit_scale=True,
                    desc=os.path.basename(output_path)[:20],
                ) as progress_bar:
                    async for chunk in response.aiter_bytes(chunk_size=8192):
                        file.write(chunk)
                        progress_bar.update(len(chunk))
        return True
    except Exception as e:
        print(f"   [!] Direct stream download failed: {e}")
        return False
 


async def main():
    if not os.path.exists(DOWNLOAD_DIR):
        os.makedirs(DOWNLOAD_DIR)

    target_url = input("Enter Series/Movie URL: ").strip()
    if not target_url:
        print("URL cannot be empty.")
        return

    print("\n[1/3] Scraping page for episodes...")
    try:
        html = fetch_html(target_url)
        episodes = extract_episode_links(html, target_url)
        show_name = get_show_name(html, target_url)

        if not episodes:
            print("[!] No downloadable links found on page.")
            return

        print(f"\n[2/3] Found {len(episodes)} episode link(s):")
        for idx, ep in enumerate(episodes, 1):
            print(f"  [{idx}] {ep['title']}")

        user_choice = (
            input(
                "\nSelect episodes to download ('all' or numbers e.g. 1,2,4): "
            )
            .strip()
            .lower()
        )

        selected_queue = []
        if user_choice == "all":
            selected_queue = episodes
        else:
            indices = [int(x.strip()) - 1 for x in user_choice.split(",")]
            selected_queue = [
                episodes[i] for i in indices if 0 <= i < len(episodes)
            ]

        if not selected_queue:
            print("No valid episodes selected.")
            return

        statuses = [
            {"title": episode["title"], "status": "QUEUED"}
            for episode in selected_queue
        ]
        render_dashboard(statuses)

        try:
            async with async_playwright() as playwright:
                for index, ep in enumerate(selected_queue):
                    file_path = get_episode_path(show_name, ep["title"])
                    os.makedirs(os.path.dirname(file_path), exist_ok=True)

                    if os.path.exists(file_path) and os.path.getsize(file_path) >= 1_048_576:
                        statuses[index]["status"] = "EXISTS"
                        render_dashboard(statuses)
                        print(f"\nAlready downloaded: {os.path.abspath(file_path)}")
                        replace = input("Replace this file? [y/N]: ").strip().lower()
                        if replace not in {"y", "yes"}:
                            statuses[index]["status"] = "SKIPPED"
                            render_dashboard(statuses)
                            print(f"Kept existing file: {os.path.abspath(file_path)}")
                            continue
                        os.remove(file_path)
                        print(f"Replacing: {os.path.abspath(file_path)}")

                    elif os.path.exists(file_path):
                        print(f"Removing incomplete file: {os.path.abspath(file_path)}")
                        os.remove(file_path)

                    statuses[index]["status"] = "QUEUED"
                    render_dashboard(statuses)

                    success = await download_episode_with_retries(
                        playwright,
                        ep,
                        file_path,
                        statuses[index],
                        index,
                        statuses,
                    )
                    if success:
                        print(f"   [Success] Saved to {file_path}")
        except asyncio.CancelledError:
            for status in statuses:
                if status["status"] in {"QUEUED", "TRY 1/3", "TRY 2/3", "TRY 3/3", "RETRY 2/3", "RETRY 3/3"}:
                    status["status"] = "CANCELLED"
            render_dashboard(statuses)
            print("\nDownload cancelled. Completed episodes were kept.")
            return

        print(
            f"\nAll operations finished! Check files in: {os.path.abspath(DOWNLOAD_DIR)}"
        )

    except Exception as e:
        print(f"\nAn error occurred: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nDownload cancelled. Any incomplete file was removed.")