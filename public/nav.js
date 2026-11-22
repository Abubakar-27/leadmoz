function createNavbar() {
  const page = document.body.dataset.page || "landing";

  const isDashboard = page === "dashboard";
  const isSettings = page === "settings";
  const isAuth = page === "auth";
  const isLanding = page === "landing";
  const isBlog = page === "blog";

  let centerLinks = "";
  let actions = "";

  if (isLanding) {
    centerLinks = `
      <a href="#product">Product Tour</a>
      <a href="#workflow">How it works</a>
      <a href="#results">Customers</a>
      <a href="#pricing">Pricing</a>
      <a href="/blog">Blog</a>
    `;

    actions = `
      <a class="smart-login" href="/auth">Log in</a>
      <a class="smart-demo" href="/auth?plan=free">Start free</a>
    `;
  }

  if (isBlog) {
    centerLinks = `
      <a href="/">Home</a>
      <a href="/#product">Product Tour</a>
      <a href="/#pricing">Pricing</a>
      <a href="/blog">Blog</a>
    `;

    actions = `
      <a class="smart-login" href="/auth">Log in</a>
      <a class="smart-demo" href="/auth?plan=free">Start free</a>
    `;
  }

  if (isAuth) {
    centerLinks = `
      <a href="/#product">Product Tour</a>
      <a href="/#pricing">Pricing</a>
    `;

    actions = `
      <a class="smart-login" href="/">Home</a>
      <a class="smart-demo" href="/auth?plan=free">Start free</a>
    `;
  }

  if (isDashboard) {
    centerLinks = `
      <a href="/app">Dashboard</a>
      <a href="/app#enrichment">Enrichment</a>
      <a href="/settings">Email Settings</a>
    `;

    actions = `
      <a class="smart-login" href="/settings">Settings</a>
      <button class="smart-demo" type="button" onclick="logout()">Logout</button>
    `;
  }

  if (isSettings) {
    centerLinks = `
      <a href="/app">Dashboard</a>
      <a href="/app#enrichment">Enrichment</a>
      <a href="/settings">Email Settings</a>
    `;

    actions = `
      <a class="smart-login" href="/app">Dashboard</a>
      <button class="smart-demo" type="button" onclick="logout()">Logout</button>
    `;
  }

  const shell = document.createElement("header");
  shell.className = "smart-shell";

  shell.innerHTML = `
    <nav id="smartTopNav" class="smart-top-nav">
      <a class="smart-brand" href="/">
        <img class="smart-logo-img" src="/leadmoz-logo.png" alt="Leadmoz" />
        <span class="smart-brand-text">Leadmoz</span>
      </a>

      <div class="smart-links">
        ${centerLinks}
      </div>

      <div class="smart-actions">
        ${actions}
      </div>
    </nav>

    <nav id="smartSplitNav" class="smart-split-nav">
      <a class="smart-split-brand" href="/">
        <img class="smart-logo-img" src="/leadmoz-logo.png" alt="Leadmoz" />
      </a>

      <div class="smart-split-links">
        ${centerLinks}
      </div>

      <div class="smart-split-actions">
        ${actions}
      </div>
    </nav>
  `;

  flowifyNavbarButtons(shell);

  document.body.prepend(shell);
}

/*
  Flow-style hover internals for the navbar buttons (.smart-login /
  .smart-demo). Mirrors the hero FlowButton: two arrows fly in/out, the
  label slides right, and a dark circle expands from the center filling
  the pill. Pure CSS animation (see nav.css); markup injected here.
*/
function flowifyNavbarButtons(root) {
  const flowArrow =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';
  root.querySelectorAll(".smart-login, .smart-demo").forEach((button) => {
    const label = button.textContent.trim();
    button.innerHTML =
      '<span class="flow-arr flow-arr-l" aria-hidden="true">' + flowArrow + "</span>"
      + '<span class="flow-label">' + label + "</span>"
      + '<span class="flow-circle" aria-hidden="true"></span>'
      + '<span class="flow-arr flow-arr-r" aria-hidden="true">' + flowArrow + "</span>";
  });
}

/*
  Domain-change notice.

  leadmoz.com is the new address, but links to leadio.site are everywhere:
  emails already sent, Instagram bios, invoices, App Store listings. Those all
  still work (the old domain 301s here), so this bar exists to explain the new
  address rather than to fix anything.

  It is dismissible and remembers the dismissal in localStorage, so it is seen
  once per browser and never again. Styles are injected here rather than added
  to fourteen page stylesheets, which keeps the notice in one place and stops
  it from drifting out of sync between pages.
*/
const DOMAIN_NOTICE_KEY = "leadmoz_domain_notice_v1";

function createDomainNotice() {
  try {
    if (localStorage.getItem(DOMAIN_NOTICE_KEY) === "1") return;
  } catch (e) {
    /* private mode or blocked storage: show the notice rather than fail */
  }

  const style = document.createElement("style");
  style.textContent = `
    .domain-notice {
      position: relative;
      z-index: 60;
      box-sizing: border-box;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 9px 44px 9px 16px;
      background: #16181d;
      color: #fff;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.4;
      letter-spacing: -.005em;
      text-align: center;
    }
    .domain-notice p { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; justify-content: center; }
    .domain-notice strong { font-weight: 600; color: #fff; }
    .domain-notice .dn-sub { color: rgba(255, 255, 255, .68); }
    .domain-notice .dn-arrow { color: #ff7a00; font-weight: 600; }
    .domain-notice-close {
      position: absolute;
      right: 8px;
      top: 50%;
      transform: translateY(-50%);
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: rgba(255, 255, 255, .62);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    .domain-notice-close:hover { color: #fff; background: rgba(255, 255, 255, .12); }
    .domain-notice-close:focus-visible { outline: 2px solid #ff7a00; outline-offset: 1px; }
    @media (max-width: 600px) {
      .domain-notice { font-size: 12px; padding: 8px 40px 8px 12px; }
      .domain-notice .dn-sub { display: none; }
    }
  `;

  const bar = document.createElement("div");
  bar.className = "domain-notice";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Site address announcement");
  bar.innerHTML = `
    <p>
      <span><strong>leadio.site</strong> <span class="dn-arrow">&rarr;</span> <strong>leadmoz.com</strong></span>
      <span class="dn-sub">Same account, plans and data &mdash; old links redirect here.</span>
    </p>
    <button class="domain-notice-close" type="button" aria-label="Dismiss announcement">&times;</button>
  `;

  bar.querySelector(".domain-notice-close").addEventListener("click", () => {
    try {
      localStorage.setItem(DOMAIN_NOTICE_KEY, "1");
    } catch (e) {
      /* dismissal still works for this page view even if it cannot persist */
    }
    bar.remove();
  });

  /*
    Placement note: the header is `position: fixed` with `!important` in every
    page stylesheet, and the page reserves its height with a body padding-top.
    Those two don't always agree - the mobile header is 82px while the reserved
    space is 72px - so the bar is left in normal flow and nudged by the measured
    difference between the header's bottom edge and the bar's top edge. A margin
    is used because `top` and `padding` are the properties pinned with
    !important; margin is not, so this cannot be silently overridden. Clamped so
    a page without a fixed header can never be pushed around.
  */
  document.head.appendChild(style);
  document.body.insertBefore(bar, document.body.firstChild);

  const alignUnderHeader = () => {
    const shell = document.querySelector(".smart-shell");
    if (!shell || getComputedStyle(shell).position !== "fixed") {
      bar.style.marginTop = "";
      return;
    }
    bar.style.marginTop = "0px";
    const gap = Math.round(shell.getBoundingClientRect().bottom - bar.getBoundingClientRect().top);
    const clamped = Math.max(-24, Math.min(24, gap));
    bar.style.marginTop = `${clamped}px`;
  };

  /*
    Crossing the mobile breakpoint changes the header height, and the offsets
    must be re-measured only once that height has actually been laid out. A
    resize listener can fire while the previous layout is still current (it then
    reads the old header and the bar drifts by a few pixels), so the header is
    observed instead: ResizeObserver reports after layout, with the new size.
    A debounced resize listener stays as a fallback for browsers without it.
  */
  let alignTimer = 0;
  let observer = null;

  const scheduleAlign = () => {
    clearTimeout(alignTimer);
    alignTimer = setTimeout(alignUnderHeader, 80);
  };

  alignUnderHeader();
  window.addEventListener("resize", scheduleAlign);

  const shell = document.querySelector(".smart-shell");
  if (shell && typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => alignUnderHeader());
    observer.observe(shell);
  }

  bar.querySelector(".domain-notice-close").addEventListener("click", () => {
    clearTimeout(alignTimer);
    window.removeEventListener("resize", scheduleAlign);
    if (observer) observer.disconnect();
  });
}

let ticking = false;

function updateSmartNavbar() {
  if (ticking) return;

  ticking = true;

  requestAnimationFrame(() => {
    const shell = document.querySelector(".smart-shell");

    if (!shell) {
      ticking = false;
      return;
    }

    const isMobile = window.innerWidth <= 820;
    const triggerPoint = isMobile ? 45 : 80;

    if (window.scrollY > triggerPoint) {
      shell.classList.add("is-scrolled");
    } else {
      shell.classList.remove("is-scrolled");
    }

    ticking = false;
  });
}

createNavbar();
createDomainNotice();
updateSmartNavbar();

window.addEventListener("scroll", updateSmartNavbar, { passive: true });
window.addEventListener("resize", updateSmartNavbar);
