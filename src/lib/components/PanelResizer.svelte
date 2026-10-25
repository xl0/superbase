<script lang="ts">
	import { innerWidth } from 'svelte/reactivity/window';

	/** Pointer/keyboard resize handle on a panel's left (sheets) or right (sidebar) edge. */
	let { width = $bindable(), min = 320, max = innerWidth.current ?? 1024, edge = 'left', label }: {
		width: number; min?: number; max?: number; edge?: 'left' | 'right'; label: string;
	} = $props();
	let drag: { x: number; width: number; pointer: number } | null = null;
	const sign = $derived(edge === 'left' ? -1 : 1);
	const clamp = (value: number) => Math.min(max, Math.max(min, value));

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Home') width = min;
		else if (event.key === 'End') width = max;
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') width = clamp(width + sign * (event.key === 'ArrowLeft' ? -32 : 32));
		else return;
		event.preventDefault();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Adjustable separators are focusable.) -->
<div role="separator" tabindex="0" aria-label={label} aria-orientation="vertical" title="Drag or use arrow keys to resize"
	aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(clamp(width))}
	class={['panel-resize absolute inset-y-0 z-30 w-1.5 cursor-col-resize touch-none outline-none', edge === 'left' ? 'left-0' : 'panel-resize-end right-0']}
	onkeydown={keydown}
	onpointerdown={(event) => {
		if (event.button !== 0 || !event.isPrimary) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag = { x: event.clientX, width: clamp(width), pointer: event.pointerId };
	}}
	onpointermove={(event) => { if (drag?.pointer === event.pointerId) width = clamp(drag.width + sign * (event.clientX - drag.x)); }}
	onlostpointercapture={() => drag = null}></div>
