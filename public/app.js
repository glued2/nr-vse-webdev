// nr-vse-webdev — small shared JS: nav highlighting, fade-in, mobile toggle
document.addEventListener("DOMContentLoaded", () => {
  // Fade-in on load
  document.body.classList.add("fade-in");

  // Highlight the active nav link based on current path
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  document.querySelectorAll(".nav-links a").forEach((link) => {
    const href = link.getAttribute("href").replace(/\/$/, "") || "/";
    if (
      href === path ||
      (href === "/index.html" && (path === "/" || path === "/index.html")) ||
      (href === "/" && path === "/index.html")
    ) {
      link.classList.add("active");
    }
  });

  // Mobile nav toggle
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      links.classList.toggle("open");
    });
  }
});
