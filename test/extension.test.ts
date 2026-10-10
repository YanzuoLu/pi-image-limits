import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { describe, expect, it } from "vitest";
import extension from "../src/index.ts";
import { CLAUDE_CODE_LIMITS, PI_DEFAULT_LIMITS, sizeImage } from "../src/resize.ts";
import { PLACEHOLDER_TEXT } from "../src/vendor/image-cap/cap.ts";

const encode = (pixels: Uint8Array, width: number, height: number, format: "png" | "jpeg" = "png") => {
	const image = new photon.PhotonImage(pixels, width, height);
	const data = Buffer.from(format === "jpeg" ? image.get_bytes_jpeg(90) : image.get_bytes()).toString("base64");
	image.free();
	return { type: "image" as const, data, mimeType: `image/${format}` };
};
const decode = (data: string) => {
	const image = photon.PhotonImage.new_from_byteslice(Buffer.from(data, "base64"));
	const out = { width: image.get_width(), height: image.get_height(), pixels: Array.from(image.get_raw_pixels()) };
	image.free();
	return out;
};
/** Smooth gradients with seeded noise; `noise` sets how hard the image is for PNG. */
const photo = (width: number, height: number, noise: number, format: "png" | "jpeg" = "png") => {
	const pixels = new Uint8Array(width * height * 4);
	let seed = 7;
	for (let index = 0; index < width * height; index++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		const n = (seed >> 16) % noise;
		const x = index % width;
		const y = Math.floor(index / width);
		pixels.set([(x * 255) / width + n, (y * 255) / height + n, 128 + n, 255].map((v) => Math.min(255, v)), index * 4);
	}
	return encode(pixels, width, height, format);
};
const flat = (width: number, height: number) => encode(new Uint8Array(width * height * 4).fill(200), width, height);

describe("sizeImage", () => {
	const limits = { ...CLAUDE_CODE_LIMITS, maxBytes: PI_DEFAULT_LIMITS.maxBytes };

	it("sends an image inside the limits in its own format untouched", () => {
		const png = flat(64, 64);
		expect(sizeImage(png, "image/png", limits)).toBe(png);
		const jpeg = photo(400, 300, 8, "jpeg");
		expect(sizeImage(jpeg, "image/jpeg", limits)).toBe(jpeg);
	});

	it("keeps a JPEG source as JPEG when Pi has already turned it into PNG", () => {
		const piOutput = photo(806, 2000, 8);
		expect(piOutput.data.length).toBeGreaterThan(2_000_000);
		const out = sizeImage(piOutput, "image/jpeg", limits);
		expect(out.mimeType).toBe("image/jpeg");
		expect(out.data.length).toBeLessThan(piOutput.data.length / 5);
		expect(decode(out.data)).toMatchObject({ width: 806, height: 2000 });
	});

	it("fits an oversized image within the dimensions in its original format", () => {
		const jpeg = sizeImage(photo(2400, 1200, 8, "jpeg"), "image/jpeg", limits);
		expect(jpeg.mimeType).toBe("image/jpeg");
		expect(decode(jpeg.data)).toMatchObject({ width: 2000, height: 1000 });
		// A PNG that still fits after resizing stays PNG, as in Claude Code.
		const png = sizeImage(photo(2400, 1200, 8), "image/png", limits);
		expect(png.mimeType).toBe("image/png");
		expect(png.data.length).toBeLessThan(limits.maxBytes);
	});

	it("falls back to JPEG when the original format is still too large", () => {
		const out = sizeImage(photo(2400, 1200, 24), "image/png", limits);
		expect(out.mimeType).toBe("image/jpeg");
		expect(decode(out.data)).toMatchObject({ width: 2000, height: 1000 });
	});

	it("ends at JPEG 1000 pixels wide at quality 20", () => {
		const out = sizeImage(photo(2400, 1200, 24), "image/png", { ...limits, maxBytes: 1000 });
		expect(out.mimeType).toBe("image/jpeg");
		expect(decode(out.data)).toMatchObject({ width: 1000, height: 500 });
	});

	it("lays transparency over white in JPEG", () => {
		const pixels = new Uint8Array(32 * 16 * 4);
		for (let index = 0; index < 32 * 16; index++) if (index % 32 >= 16) pixels[index * 4 + 3] = 255;
		const { pixels: out } = decode(sizeImage(encode(pixels, 32, 16), "image/jpeg", limits).data);
		const at = (x: number, y: number) => out.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
		for (const value of at(4, 8)) expect(value).toBeGreaterThan(243);
		for (const value of at(27, 8)) expect(value).toBeLessThan(12);
	});
});

function harness(model?: object) {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	extension({ on: (name: string, handler: any) => (handlers[name] = handler) } as any);
	const cwd = mkdtempSync(join(tmpdir(), "pi-image-limits-"));
	return { cwd, call: (name: string, event: any) => handlers[name]!(event, { cwd, model }) };
}

describe("extension", () => {
	it("sends what read opened as JPEG in JPEG, and says so", async () => {
		const { cwd, call } = harness();
		const source = photo(1431, 3549, 8, "jpeg");
		writeFileSync(join(cwd, "tall.jpg"), Buffer.from(source.data, "base64"));
		const note = { type: "text", text: "Read image file [image/png]\n[Image: original 1431x3549, displayed at 806x2000.]" };
		const result = await call("tool_result", { toolName: "read", input: { path: "tall.jpg" }, content: [note, photo(806, 2000, 8)] });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(result.content[0].text).toBe("Read image file [image/jpeg]\n[Image: original 1431x3549, displayed at 806x2000.]");
	});

	it("leaves other tool images inside the limits alone and sizes prompt images", async () => {
		const { call } = harness();
		expect(await call("tool_result", { toolName: "screenshot", input: {}, content: [flat(64, 64)] })).toBeUndefined();
		expect(call("input", { text: "look", images: [flat(64, 64)], source: "interactive" })).toEqual({ action: "continue" });
		const big = call("input", { text: "look", images: [photo(2400, 1200, 8, "jpeg")], source: "interactive" });
		expect(big).toMatchObject({ action: "transform", text: "look", images: [{ mimeType: "image/jpeg" }] });
	});

	it("trims the oldest images from requests to any model", () => {
		const image = (bytes: number) => ({ type: "image", data: "A".repeat(bytes), mimeType: "image/jpeg" });
		const history = (count: number, bytes: number) =>
			Array.from({ length: count }, (_, index) => ({ role: "toolResult", toolCallId: `c${index}`, content: [image(bytes)] }));
		const gpt = harness({ provider: "openai-codex", contextWindow: 128_000 }).call;
		const counted = gpt("context", { messages: history(101, 10) }).messages;
		expect(counted.filter((m: any) => m.content[0].type === "image")).toHaveLength(80);
		expect(counted[0].content[0]).toEqual({ type: "text", text: PLACEHOLDER_TEXT });
		expect(gpt("context", { messages: history(100, 10) })).toBeUndefined();
		const sized = gpt("context", { messages: history(11, 3 * 1024 * 1024) }).messages;
		// 27 MB at the ninth image trips the 24 MB cap and trims to 4 images (12 MB); two more bring it to 18 MB.
		expect(sized.filter((m: any) => m.content[0].type === "image")).toHaveLength(6);
		const large = harness({ provider: "anthropic", contextWindow: 1_000_000 }).call;
		expect(large("context", { messages: history(500, 10) })).toBeUndefined();
	});
});
