"""End-to-end fixtures: serve dist/site, drive Firefox and Chromium.

    .venv/bin/pytest tests/e2e            # both browsers
    .venv/bin/pytest tests/e2e --browser firefox
SITE=<dir> overrides the site directory.
"""
import functools
import http.server
import os
import re
import tempfile
import threading
import time
from pathlib import Path

import pytest
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
SITE = Path(os.environ.get("SITE", ROOT / "dist" / "site"))
PROMPT = re.compile(r"root@b0tn3t:[^\n]*# *$")


def pytest_addoption(parser):
    parser.addoption("--browser", action="append", choices=["firefox", "chromium"], help="default: both")


def pytest_generate_tests(metafunc):
    if "browser_name" in metafunc.fixturenames:
        metafunc.parametrize("browser_name", metafunc.config.getoption("browser") or ["firefox", "chromium"], scope="session")


class Quiet(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}

    def log_message(self, *a):
        pass


@pytest.fixture(scope="session")
def server():
    assert (SITE / "index.html").exists(), f"build the site first: {SITE}"
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(SITE)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    httpd.shutdown()


@pytest.fixture(scope="session")
def downloads():
    return Path(tempfile.mkdtemp(prefix="b0tn3t-dl-"))


def make_driver(name, downloads, mobile=False):
    if name == "firefox":
        o = webdriver.FirefoxOptions()
        o.add_argument("-headless")
        o.set_preference("browser.download.folderList", 2)
        o.set_preference("browser.download.dir", str(downloads))
        o.set_preference("browser.download.useDownloadDir", True)
        o.set_preference("browser.helperApps.neverAsk.saveToDisk", "application/octet-stream")
        o.set_preference("dom.disable_open_during_load", False)
        # every test reloads a page with a 128 MB machine: don't keep old ones around
        o.set_preference("browser.sessionhistory.max_total_viewers", 0)
        o.set_preference("dom.ipc.processCount", 1)
        d = webdriver.Firefox(options=o)
    else:
        o = webdriver.ChromeOptions()
        o.binary_location = "/usr/bin/chromium"
        for a in ["--headless=new", "--no-first-run", "--disable-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=512",
                  "--disable-features=BackForwardCache", "--renderer-process-limit=2"]:
            o.add_argument(a)
        o.add_experimental_option("prefs", {"download.default_directory": str(downloads), "download.prompt_for_download": False})
        o.set_capability("goog:loggingPrefs", {"browser": "ALL"})
        if mobile:
            o.add_experimental_option("mobileEmulation", {"deviceMetrics": {"width": 390, "height": 760, "pixelRatio": 3.0, "touch": True},
                                                          "userAgent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/156 Mobile Safari/537.36"})
        d = webdriver.Chrome(options=o)
    d.set_window_size(1200, 800)
    d.set_script_timeout(120)
    d.set_page_load_timeout(60)
    return d


class Page:
    """The terminal page: type, wait for output, run commands."""

    def __init__(self, driver, url):
        self.d = driver
        self.url = url

    def open(self, query=""):
        t = time.time()
        self.d.get(self.url + query)
        self.d.execute_async_script("window.vm.ready.then(() => arguments[0](true))")
        self.ready_s = time.time() - t
        self.wait(lambda s: PROMPT.search(s), 30, "first prompt")
        return self

    def js(self, script, *args):
        return self.d.execute_script(script, *args)

    def screen(self):
        return self.js("return window.vm.screen()")

    def wait(self, pred, timeout=30, what="screen"):
        try:
            return WebDriverWait(self.d, timeout, 0.1).until(lambda d: pred(self.screen()))
        except Exception:
            raise AssertionError(f"timeout waiting for {what}; screen:\n{self.screen()[-2000:]}")

    def keys(self, text):
        self.d.find_element(By.CSS_SELECTOR, ".xterm-helper-textarea").send_keys(text)

    def run(self, cmd, timeout=30):
        """type a command, return its output (text between the command and the next prompt)"""
        marker = f"m{time.time_ns()}"
        self.keys(f": {marker}; {cmd}\n")
        out = self.wait(lambda s: re.search(re.escape(marker) + r"; [^\n]*\n([\s\S]*?)\n?root@b0tn3t:[^\n]*# *$", s), timeout, cmd)
        return out.group(1)

    def exec(self, cmd):
        return self.d.execute_async_script(
            "window.vm.exec(arguments[0]).then(r => arguments[1]([r.code, r.out]))", cmd)


@pytest.fixture
def driver(browser_name, downloads):
    # a fresh browser (and profile) per test: v86's JIT and saved states make
    # a page heavy, and memory would pile up over a long run
    d = make_driver(browser_name, downloads)
    yield d
    d.quit()


@pytest.fixture
def page(driver, server):
    return Page(driver, server)
