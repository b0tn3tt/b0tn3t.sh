"""The site in real browsers. Tests run in file order and share one
browser profile per browser, like one visitor coming back."""
import base64
import re
import time

import pytest
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

from conftest import PROMPT, ROOT, Page, make_driver

CONTENT = {n: (ROOT / "content" / f"{n}.txt").read_text() for n in ["whois", "contacts", "motd"]}
TIMINGS = {}


def clean(text):
    return "\n".join(l.rstrip() for l in text.strip("\n").splitlines())


def test_loads_fast_with_motd_and_prompt(page, browser_name):
    page.open("?fresh")
    s = page.screen()
    assert CONTENT["motd"].splitlines()[0].rstrip() in s
    assert PROMPT.search(s)
    t = page.js("return window.vm.timings")
    TIMINGS[browser_name] = {"ready_s": round(page.ready_s, 2), **t}
    print(f"\n# {browser_name}: interactive after {page.ready_s:.2f}s, page timings {t}")
    assert page.ready_s < 15
    assert page.js("return document.title") in ("b0tn3t.sh", "~ — b0tn3t")


def test_whois_and_contacts_are_the_repo_text(page):
    page.open()
    for name in ["whois", "contacts"]:
        assert clean(page.run(name)) == clean(CONTENT[name])


def test_fetch_and_python(page, browser_name):
    page.open()
    out = page.run("fetch")
    assert "b0tn3t LFS 1.0" in out and "Kernel" in out
    assert ("Firefox" if browser_name == "firefox" else "Chrome") in out
    cols, rows = page.js("return [window.vm.term.cols, window.vm.term.rows]")
    assert f"xterm.js {cols}x{rows}" in out
    assert page.run("python -c 'print(6*7)'").strip() == "42"
    assert page.run("neofetch --plain | head -3 | tail -1").strip().startswith("─")


def test_terminal_size_follows_the_window(page, driver):
    page.open()
    driver.set_window_size(900, 600)
    time.sleep(0.5)
    cols, rows = page.js("return [window.vm.term.cols, window.vm.term.rows]")
    assert page.run("stty size").strip() == f"{rows} {cols}"
    driver.set_window_size(1200, 800)


def test_unicode_and_title(page):
    page.open()
    assert page.run("echo 'привет 🐱 ✓'").strip() == "привет 🐱 ✓"
    page.run("cd /etc")
    WebDriverWait(page.d, 5).until(lambda d: d.title.startswith("/etc"))
    page.run("cd")


def test_blog_opens_a_new_tab(page, driver):
    page.open()
    main = driver.current_window_handle
    before = set(driver.window_handles)
    page.keys("blog\n")
    WebDriverWait(driver, 15).until(lambda d: len(d.window_handles) > len(before))
    page.wait(lambda s: "opened https://blog.b0tn3t.sh" in s, 10, "vm reply")
    new = (set(driver.window_handles) - before).pop()
    driver.switch_to.window(new)
    WebDriverWait(driver, 15).until(lambda d: "blog.b0tn3t.sh" in d.current_url)
    driver.close()
    driver.switch_to.window(main)


def test_copy_paste_and_osc52(page, driver):
    page.open()
    # observe the page's clipboard calls (headless browsers keep the real clipboard to themselves)
    page.js("""window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
      navigator.clipboard.readText = async () => 'from the clipboard ✓';""")
    page.run("echo -n 'copied via vm' | vm copy")
    assert page.js("return window.__copied.at(-1)") == "copied via vm"
    assert page.run("vm paste").strip() == "from the clipboard ✓"
    b64 = base64.b64encode("osc 52 ✓".encode()).decode()
    page.run(f"printf '\\033]52;c;{b64}\\a'")
    assert page.js("return window.__copied.at(-1)") == "osc 52 ✓"
    # Ctrl+Shift+C copies the selection
    page.js("window.vm.term.select(0, 0, 5)")
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys
    ta = driver.find_element(By.CSS_SELECTOR, ".xterm-helper-textarea")
    ActionChains(driver).key_down(Keys.CONTROL).key_down(Keys.SHIFT).send_keys_to_element(ta, "c").key_up(Keys.SHIFT).key_up(Keys.CONTROL).perform()
    assert page.js("return window.__copied.at(-1)") == page.js("return window.vm.term.getSelection()")


def test_download_a_file(page, downloads):
    page.open()
    page.run("echo 'download me' > /tmp/report.txt && vm dl /tmp/report.txt")
    target = downloads / "report.txt"
    WebDriverWait(page.d, 20).until(lambda d: target.exists() and target.stat().st_size > 0)
    assert target.read_text() == "download me\n"


def test_upload_with_vm_up(page, tmp_path):
    page.open()
    f = tmp_path / "hello upload.txt"
    f.write_text("uploaded from the computer\n")
    page.keys("mkdir -p /root/up && vm up /root/up\n")
    page.wait(lambda s: "choose files in the browser" in s, 10, "vm up prompt")
    page.js("const i = document.querySelector('#files'); i.hidden = false; i.style.cssText = 'position:fixed;top:0;left:0;z-index:99';")
    page.d.find_element(By.CSS_SELECTOR, "#files").send_keys(str(f))
    page.wait(lambda s: "/root/up/hello upload.txt (27 bytes)" in s, 20, "upload listing")
    page.js("const i = document.querySelector('#files'); i.hidden = true; i.style.cssText = '';")
    page.js("document.querySelector('#dialog').classList.remove('open')")
    assert page.exec("cat '/root/up/hello upload.txt'") == [0, "uploaded from the computer\n"]


def test_drag_and_drop_upload(page):
    page.open()
    page.run("mkdir -p /root/dropzone && cd /root/dropzone")
    page.js("""const dt = new DataTransfer();
      dt.items.add(new File(['dropped bytes'], 'dropped.txt', {type: 'text/plain'}));
      window.dispatchEvent(new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true}));""")
    WebDriverWait(page.d, 20).until(lambda d: "saved /root/dropzone/dropped.txt" in d.find_element(By.CSS_SELECTOR, "#toast").text)
    assert page.exec("cat /root/dropzone/dropped.txt") == [0, "dropped bytes"]
    page.run("cd")


def test_theme_and_font_persist(page):
    page.open()
    page.run("vm theme amber")
    assert page.js("return window.vm.term.options.theme.background") == "#0a0700"
    page.run("vm font 17")
    assert page.js("return window.vm.term.options.fontSize") == 17
    assert "amber" in page.run("vm theme")
    page.open()
    assert page.js("return window.vm.settings.get('theme')") == "amber"
    assert page.js("return window.vm.term.options.fontSize") == 17


def test_saved_machine_survives_a_reload(page):
    page.open()
    page.run("echo 'still here' > /root/persist.txt")
    out = page.run("vm save")
    assert re.search(r"machine saved \([\d.]+ MB\)", out), out
    page.open()
    assert page.run("cat /root/persist.txt").strip() == "still here"
    assert "vm save" in page.screen(), "the saved screen comes back too"


SAVED_AT = ("indexedDB.open('b0tn3t').onsuccess = (e) => { const r = e.target.result.transaction('kv').objectStore('kv').get('save');"
            " r.onsuccess = () => arguments[0](r.result ? r.result.created : 0); }")


def test_autosave_when_the_tab_is_hidden(page):
    page.open()
    page.run("echo autosaved > /root/auto.txt")
    before = page.d.execute_async_script(SAVED_AT)
    page.js("""Object.defineProperty(document, 'hidden', {value: true, configurable: true});
      document.dispatchEvent(new Event('visibilitychange'));""")
    WebDriverWait(page.d, 30).until(lambda d: d.execute_async_script(SAVED_AT) > before)
    page.open()
    assert page.run("cat /root/auto.txt").strip() == "autosaved"


def test_snapshots(page):
    page.open()
    page.run("echo one > /root/snap.txt")
    assert "snapshot first saved" in page.run("vm save first")
    page.run("echo two > /root/snap.txt")
    assert "first" in page.run("vm snaps")
    page.keys("vm load first\n")
    time.sleep(1)
    page.open()
    assert page.run("cat /root/snap.txt").strip() == "one"
    assert "removed first" in page.run("vm snaps rm first")


def test_info(page):
    page.open()
    out = page.run("vm info")
    assert "terminal" in out and "128 MB RAM" in out and "of 512.0 MB" in out


def test_reset_wipes_everything(page):
    page.open()
    page.keys("vm reset -y\n")
    time.sleep(1.5)
    page.open()
    assert "No such file" in page.run("cat /root/persist.txt")
    assert page.js("return window.vm.settings.get('theme')") == "dark"
    assert page.js("return localStorage.getItem('b0tn3t.settings')") is None


def test_no_console_errors(page, browser_name):
    if browser_name != "chromium":
        pytest.skip("only chromium exposes the console log")
    page.open()
    errors = [l for l in page.d.get_log("browser") if l["level"] == "SEVERE" and "favicon" not in l["message"]]
    assert errors == [], errors


def test_mobile_key_bar(browser_name, server, downloads):
    if browser_name != "chromium":
        pytest.skip("mobile emulation is chromium-only")
    d = make_driver("chromium", downloads, mobile=True)
    try:
        p = Page(d, server).open("?fresh")
        assert p.js("return document.body.classList.contains('keys')")
        bar = d.find_element(By.CSS_SELECTOR, "#bar")
        assert bar.is_displayed()
        assert p.js("return window.vm.term.options.fontSize") == 13
        # Ctrl via the sticky key interrupts a running command
        p.keys("sleep 300\n")
        time.sleep(0.5)
        tap = lambda key: d.execute_script(
            "const b = document.querySelector(`[data-key='${arguments[0]}']`);"
            "b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); b.dispatchEvent(new PointerEvent('pointerup', {bubbles: true}));", key)
        tap("CTRL")
        assert "on" in d.find_element(By.CSS_SELECTOR, "[data-key='CTRL']").get_attribute("class")
        p.keys("c")
        p.wait(lambda s: re.search(r"\^C\s*\nroot@b0tn3t:~# *$", s), 10, "^C")
        # history with the arrow key
        p.run("echo from-history")
        tap("UP")
        p.wait(lambda s: s.rstrip().endswith("echo from-history"), 5, "history recall")
        p.keys("\n")
        p.wait(lambda s: s.count("from-history\n") >= 2, 5)
    finally:
        d.quit()
