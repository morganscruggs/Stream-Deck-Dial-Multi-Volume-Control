// Renders animated versions of gallery.html slides as MP4s for the Marketplace gallery (1920x1080, Elgato's
// required video size). Each video's setup function runs in the page and defines window.__frame(i), which
// draws frame i; frames are captured one at a time, so output is deterministic, and every timeline ends in
// the state it starts in so the videos loop cleanly.
//
//   1.2  The Media dial turns clockwise then counter-clockwise; the strip and the three linked mixer
//        sliders follow it in 5% steps (the plugin's default step size).
//   5    Turn up/down, push to mute/unmute, push to pause, tap the touch strip to play - with the matching
//        callout on the left lit up for each.
//
// Usage: npm install, then `npm run video` (all) or `node render-video.mjs 5` (just one).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const FPS = 30;

/**
 * Runs in the page before a video's setup: video-only CSS plus helpers shared by the setups below.
 */
function prepare() {
	const style = document.createElement("style");
	style.textContent = `
		/* Stretch the 1920x960 slide to the video's 1080 height; each slide centres its content itself. */
		html, body { height: 1080px !important; }
		.knob { position: relative; }
		/* Coarser knurl than the stills: with 8deg ridges, the fastest turn moves nearly a full ridge per
		   frame, which strobes and can read as the knob spinning backwards. */
		.knob div { will-change: transform; background: repeating-conic-gradient(#3e4047 0 7.5deg, #26282d 7.5deg 15deg); }
		.spin { position: absolute; left: 50%; top: 50%; width: 220px; height: 220px; margin: -110px; pointer-events: none; opacity: 0; }
		.ring { position: absolute; left: 50%; top: 50%; width: 128px; height: 128px; margin: -64px; box-sizing: border-box;
			border-radius: 50%; border: 5px solid #7c5cff; opacity: 0; pointer-events: none; }
		.touch { position: absolute; left: 150px; top: 75px; width: 80px; height: 80px; margin: -40px; border-radius: 50%;
			background: rgba(255,255,255,.55); box-shadow: 0 0 0 6px rgba(255,255,255,.25); opacity: 0; pointer-events: none; }`;
	document.head.appendChild(style);

	window.__ease = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

	// Curved arrow hugging the knob's upper-right edge; mirrored for counter-clockwise turns.
	window.__addArrow = (knobWrap) => {
		knobWrap.insertAdjacentHTML(
			"beforeend",
			`<svg class="spin" viewBox="0 0 220 220">
				<path d="M 54.1 31.7 A 96 96 0 0 1 195.6 69.5" fill="none" stroke="#7c5cff" stroke-width="9" stroke-linecap="round"/>
				<path d="M 207 61 L 205 90 L 181 74 Z" fill="#7c5cff"/>
			</svg>`
		);
		return knobWrap.querySelector(".spin");
	};

	// Fades the arrow in only while a turn segment [s, e) is in progress, pointing the way it's going.
	window.__showArrow = (arrow, t, turn) => {
		if (!turn) {
			arrow.style.opacity = "0";
			return;
		}
		const [s, e, from, to] = turn;
		arrow.style.opacity = String(Math.min(1, Math.min(t - s, e - t) / 0.25));
		arrow.style.transform = to < from ? "scaleX(-1)" : "none";
	};

	/**
	 * Volume at time t over a list of turn segments [start s, end s, from %, to %]: the value moves in whole
	 * steps like real dial ticks, while `travel` (total % turned so far) moves smoothly, for the knob angle.
	 */
	window.__turnAt = (turns, t, start, step) => {
		let vol = start;
		let travel = 0;
		let turn = null;
		for (const seg of turns) {
			const [s, e, from, to] = seg;
			if (t >= e) {
				vol = to;
				travel += to - from;
				continue;
			}
			if (t >= s) {
				const p = window.__ease((t - s) / (e - s));
				vol = from + Math.sign(to - from) * step * Math.round((p * Math.abs(to - from)) / step);
				travel += (to - from) * p;
				turn = seg;
			}
			break;
		}
		return { vol, travel, turn };
	};
}

/**
 * Slide 1.2: one Media dial driving Chrome, VLC and Windows Media Player in the volume mixer.
 */
function setupMixer(fps) {
	const TURNS = [
		[0.8, 3.0, 70, 100],
		[3.8, 7.0, 100, 30],
		[7.8, 9.4, 30, 70]
	];
	const DEG_PER_PERCENT = 3;

	const slide = document.getElementById("s1.2");
	const knobWrap = slide.querySelector(".knob");
	const knob = knobWrap.querySelector("div");
	const arrow = window.__addArrow(knobWrap);
	const stripValue = slide.querySelector(".seg .v");
	const stripBar = slide.querySelector(".seg .bar i");
	const sliders = [...slide.querySelectorAll(".mx-row.on")].map((row) => ({
		fill: row.querySelector(".mx-t b"),
		thumb: row.querySelector(".mx-t s"),
		label: row.querySelector(".mx-s span")
	}));

	let shown = 70;
	window.__frame = (i) => {
		const t = i / fps;
		const { vol, travel, turn } = window.__turnAt(TURNS, t, 70, 5);
		knob.style.transform = `rotate(${travel * DEG_PER_PERCENT}deg)`;
		window.__showArrow(arrow, t, turn);

		// Bars glide toward each new step rather than jumping.
		shown += (vol - shown) * 0.5;
		if (Math.abs(vol - shown) < 0.05) shown = vol;

		stripValue.textContent = `${vol}%`;
		stripBar.style.width = `${shown}%`;
		for (const sl of sliders) {
			sl.fill.style.width = `${shown}%`;
			sl.thumb.style.left = `${shown}%`;
			sl.label.textContent = String(vol);
		}
	};
}

/**
 * Slide 5: "Turn, push, or tap" - the Game One dial (Mute/Unmute mode) turns up and down then is pushed to
 * mute and unmute; the Music dial (Play/Pause mode) is pushed to pause, then its touch strip tapped to play.
 */
function setupControls(fps) {
	const TURNS = [
		[0.6, 2.4, 45, 75],
		[2.9, 4.7, 75, 45]
	];
	const MUTE = 5.3;
	const UNMUTE = 6.8;
	const PAUSE = 8.0;
	const TAP = 9.6;
	// The state flips this long after a press starts - at the bottom of the press, not the start.
	const LAND = 0.12;
	const DEG_PER_PERCENT = 3;
	// Which callout (Rotate / Push / Tap) is lit up at time t; back to the first at the end for the loop.
	const calloutAt = (t) => (t < 4.95 ? 0 : t < 9.2 ? 1 : t < 11.0 ? 2 : 0);

	const slide = document.getElementById("s5");
	const [seg1, seg2] = slide.querySelectorAll(".seg");
	const [knobWrap1, knobWrap2] = slide.querySelectorAll(".knob");
	const knob1 = knobWrap1.querySelector("div");
	const knob2 = knobWrap2.querySelector("div");
	const arrow = window.__addArrow(knobWrap1);
	const addRing = (wrap) => {
		wrap.insertAdjacentHTML("beforeend", `<i class="ring"></i>`);
		return wrap.querySelector(".ring");
	};
	const ring1 = addRing(knobWrap1);
	const ring2 = addRing(knobWrap2);
	seg2.insertAdjacentHTML("beforeend", `<span class="touch"></span>`);
	const touch = seg2.querySelector(".touch");
	const callouts = [...slide.querySelectorAll(".callout")];

	// 0..1 depth of a dial press starting at `at`: quick press down, slower release.
	const pressAt = (t, at) => {
		const d = t - at;
		if (d < 0 || d > 0.3) return 0;
		return d < 0.1 ? d / 0.1 : 1 - (d - 0.1) / 0.2;
	};
	// 0..1 progress of a 0.6s pulse (ring or touch ripple) started by whichever of `ats` is in progress.
	const pulseAt = (t, ats) => {
		for (const at of ats) {
			const d = t - at;
			if (d >= 0 && d <= 0.6) return d / 0.6;
		}
		return null;
	};
	const showRing = (ring, p) => {
		ring.style.opacity = p === null ? "0" : String(0.9 * (1 - p));
		ring.style.transform = p === null ? "none" : `scale(${1 + 0.5 * p})`;
	};

	// Mirrors updateFeedback in volume-control.ts: muted shows "Muted", the red slash, a grey value and an
	// empty bar; paused shows the pause badge over the icon.
	const renderSeg = (seg, title, icon, overlay, vol, bar, dim) => {
		seg.classList.toggle("dim", dim);
		seg.querySelector(".t").textContent = title;
		seg.querySelector(".v").textContent = `${vol}%`;
		seg.querySelector(".bar i").style.width = `${bar}%`;
		const iconEl = seg.querySelector(".i");
		const key = icon + overlay;
		if (iconEl.dataset.key !== key) {
			iconEl.dataset.key = key;
			iconEl.innerHTML = `<svg viewBox="0 0 100 100"><use href="#${icon}"/>${overlay ? `<use href="#${overlay}"/>` : ""}</svg>`;
		}
	};

	let shown = 45;
	let calloutOpacity = callouts.map((_, n) => (n === 0 ? 1 : 0.35));

	window.__frame = (i) => {
		const t = i / fps;
		const { vol, travel, turn } = window.__turnAt(TURNS, t, 45, 5);
		const muted = t >= MUTE + LAND && t < UNMUTE + LAND;
		const paused = t >= PAUSE + LAND && t < TAP + 0.08;

		const barTarget = muted ? 0 : vol;
		shown += (barTarget - shown) * 0.5;
		if (Math.abs(barTarget - shown) < 0.05) shown = barTarget;

		renderSeg(seg1, muted ? "Muted" : "Game One", "game", muted ? "mute" : "", vol, shown, muted);
		renderSeg(seg2, "Music", "music", paused ? "pause" : "", 80, 80, false);

		const press1 = Math.max(pressAt(t, MUTE), pressAt(t, UNMUTE));
		knob1.style.transform = `rotate(${travel * DEG_PER_PERCENT}deg) scale(${1 - 0.08 * press1})`;
		knob2.style.transform = `scale(${1 - 0.08 * pressAt(t, PAUSE)})`;
		window.__showArrow(arrow, t, turn);
		showRing(ring1, pulseAt(t, [MUTE, UNMUTE]));
		showRing(ring2, pulseAt(t, [PAUSE]));

		const tap = pulseAt(t, [TAP]);
		touch.style.opacity = tap === null ? "0" : String(0.85 * (1 - tap));
		touch.style.transform = tap === null ? "none" : `scale(${0.5 + 0.7 * tap})`;

		const lit = calloutAt(t);
		calloutOpacity = calloutOpacity.map((o, n) => {
			const target = n === lit ? 1 : 0.35;
			return o + (target - o) * 0.25;
		});
		callouts.forEach((c, n) => (c.style.opacity = calloutOpacity[n].toFixed(3)));
	};
}

const VIDEOS = {
	"1.2": { duration: 10, setup: setupMixer },
	"5": { duration: 11.6, setup: setupControls }
};

const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VIDEOS);
const browser = await puppeteer.launch({
	executablePath: EDGE,
	headless: true,
	args: ["--allow-file-access-from-files", "--hide-scrollbars"],
	defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }
});

for (const id of ids) {
	const video = VIDEOS[id];
	if (!video) throw new Error(`No video defined for slide "${id}" (have: ${Object.keys(VIDEOS).join(", ")})`);

	const page = await browser.newPage();
	await page.goto(pathToFileURL(path.join(here, "gallery.html")).href + "#" + id, { waitUntil: "load" });
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all([...document.images].map((img) => (img.complete ? 0 : new Promise((r) => (img.onload = img.onerror = r)))));
	});
	await page.evaluate(prepare);
	await page.evaluate(video.setup, FPS);

	const out = path.join(here, `gallery-${id}.mp4`);
	const frames = Math.round(video.duration * FPS);
	const ffmpeg = spawn(
		ffmpegPath,
		["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
			"-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
		{ stdio: ["pipe", "inherit", "inherit"] }
	);
	for (let i = 0; i < frames; i++) {
		await page.evaluate((n) => window.__frame(n), i);
		const png = await page.screenshot({ type: "png" });
		if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
	}
	ffmpeg.stdin.end();
	await new Promise((resolve, reject) => ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
	await page.close();
	console.log(`Wrote ${out} (${frames} frames @ ${FPS}fps)`);
}

await browser.close();
