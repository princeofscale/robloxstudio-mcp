const CaptureService = game.GetService("CaptureService");
const AssetService = game.GetService("AssetService");

const MAX_TILE_SIZE = 1024;
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD_BYTE = string.byte("=")[0];

const B64: number[] = [];
for (let i = 0; i < 64; i++) {
	B64[i] = string.byte(BASE64_CHARS, i + 1)[0];
}

function encodeBase64(buf: buffer): string {
	const len = buffer.len(buf);
	const fullTriples = math.floor(len / 3);
	const remaining = len - fullTriples * 3;
	const outLen = (fullTriples + (remaining > 0 ? 1 : 0)) * 4;
	const out = buffer.create(outLen);

	let si = 0;
	let di = 0;

	for (let t = 0; t < fullTriples; t++) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		const b2 = buffer.readu8(buf, si + 2);

		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.bor(bit32.lshift(bit32.band(b1, 15), 2), bit32.rshift(b2, 6))]);
		buffer.writeu8(out, di + 3, B64[bit32.band(b2, 63)]);

		si += 3;
		di += 4;
	}

	if (remaining === 2) {
		const b0 = buffer.readu8(buf, si);
		const b1 = buffer.readu8(buf, si + 1);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.bor(bit32.lshift(bit32.band(b0, 3), 4), bit32.rshift(b1, 4))]);
		buffer.writeu8(out, di + 2, B64[bit32.lshift(bit32.band(b1, 15), 2)]);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	} else if (remaining === 1) {
		const b0 = buffer.readu8(buf, si);
		buffer.writeu8(out, di, B64[bit32.rshift(b0, 2)]);
		buffer.writeu8(out, di + 1, B64[bit32.lshift(bit32.band(b0, 3), 4)]);
		buffer.writeu8(out, di + 2, PAD_BYTE);
		buffer.writeu8(out, di + 3, PAD_BYTE);
	}

	return buffer.tostring(out);
}

function readPixelsTiled(img: EditableImage, w: number, h: number): buffer {
	const BYTES_PER_PIXEL = 4;
	const fullBuf = buffer.create(w * h * BYTES_PER_PIXEL);
	const fullRowBytes = w * BYTES_PER_PIXEL;

	for (let ty = 0; ty < h; ty += MAX_TILE_SIZE) {
		const tileH = math.min(MAX_TILE_SIZE, h - ty);
		for (let tx = 0; tx < w; tx += MAX_TILE_SIZE) {
			const tileW = math.min(MAX_TILE_SIZE, w - tx);
			const tileBuf = img.ReadPixelsBuffer(new Vector2(tx, ty), new Vector2(tileW, tileH));
			const tileRowBytes = tileW * BYTES_PER_PIXEL;
			for (let row = 0; row < tileH; row++) {
				buffer.copy(fullBuf, (ty + row) * fullRowBytes + tx * BYTES_PER_PIXEL, tileBuf, row * tileRowBytes, tileRowBytes);
			}
		}
	}
	return fullBuf;
}

function captureScreenshotData(): unknown {
	let contentId: string | undefined;

	CaptureService.CaptureScreenshot((id: string) => {
		contentId = id;
	});

	const startTime = tick();
	while (contentId === undefined) {
		if (tick() - startTime > 10) {
			return {
				error: "Screenshot capture timed out. Ensure the Studio viewport is visible and you are in Edit mode (not Play mode). Known Roblox bug: capture may fail if viewport renders a solid color.",
			};
		}
		task.wait(0.1);
	}

	const [editableOk, editableResult] = pcall(() => {
		return AssetService.CreateEditableImageAsync(Content.fromUri(contentId!));
	});

	if (!editableOk) {
		return {
			error: `Failed to create EditableImage from screenshot. Enable EditableImage API: Game Settings > Security > 'Allow Mesh / Image APIs'. (${tostring(editableResult)})`,
		};
	}

	const editableImage = editableResult as EditableImage;
	const imgSize = editableImage.Size;
	const w = math.floor(imgSize.X);
	const h = math.floor(imgSize.Y);

	const [readOk, pixelBuffer] = pcall(() => {
		return readPixelsTiled(editableImage, w, h);
	});

	editableImage.Destroy();

	if (!readOk) {
		return { error: `Failed to read pixel data: ${tostring(pixelBuffer)}` };
	}

	const base64Data = encodeBase64(pixelBuffer as buffer);

	return { success: true, width: w, height: h, data: base64Data };
}

function captureScreenshot(): unknown {
	return captureScreenshotData();
}

export = {
	captureScreenshotData,
	captureScreenshot,
};
