import { parentPort } from 'node:worker_threads';

// One shard of the sharded vector scan (see the backend header in vectors.mjs). Receives a
// SharedArrayBuffer-backed matrix plus a contiguous row range and answers its local top-k as
// parallel (row index, score) arrays. The per-row loop, the clamp and the strict-`<` insertion
// are byte-for-byte the inline scan's, so equal scores keep encounter (row) order and the main
// thread's merge reproduces the inline result exactly. Do not unroll the dot product: a
// different summation order changes the float result, and the equivalence test pins it.
parentPort.on('message', message => {
	const { id, buffer, dim, start, end, k, query } = message;
	try {
		if (message.crash) throw new Error('injected shard failure');
		const matrix = new Float32Array(buffer);
		const best = [];
		let worst = -Infinity;
		for (let row = start; row < end; row++) {
			const offset = row * dim;
			let sum = 0;
			for (let d = 0; d < dim; d++) sum += matrix[offset + d] * query[d];
			if (best.length === k && sum <= worst) continue;
			const entry = { row, score: Math.max(-1, Math.min(1, sum)) };
			let index = best.length - 1;
			best.push(entry);
			while (index >= 0 && best[index].score < entry.score) {
				best[index + 1] = best[index];
				index--;
			}
			best[index + 1] = entry;
			if (best.length > k) best.pop();
			worst = best[best.length - 1].score;
		}
		const rows = new Int32Array(best.length);
		const scores = new Float64Array(best.length);
		for (let i = 0; i < best.length; i++) {
			rows[i] = best[i].row;
			scores[i] = best[i].score;
		}
		parentPort.postMessage({ id, rows, scores }, [rows.buffer, scores.buffer]);
	} catch (e) {
		parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
	}
});
