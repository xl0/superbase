<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import type { Dialog as DialogPrimitive } from 'bits-ui';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import PanelResizer from './PanelResizer.svelte';

	/** Right-hand panel: unblurred and resizable. An outside click closes it like Esc: `onOpenChange(false)`,
	 * where callers with unsaved input ask before discarding it. */
	let { open = true, onOpenChange, width = 640, label, ref = $bindable(null), children, ...rest }: DialogPrimitive.ContentProps & {
		open?: boolean; onOpenChange?: (open: boolean) => void; width?: number; label: string; children: Snippet;
	} = $props();
	let current = $state(untrack(() => width));
</script>

<Sheet.Root {open} {onOpenChange}>
	<Sheet.Content bind:ref side="right" showCloseButton={false} style={`width:min(${current}px,100vw);max-width:100vw;height:100dvh;`} {...rest}>
		<PanelResizer bind:width={current} {label} />
		{@render children()}
	</Sheet.Content>
</Sheet.Root>
