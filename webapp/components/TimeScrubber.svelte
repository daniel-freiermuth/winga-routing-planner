<script lang="ts">
  interface Props {
    windTimes: string[];
    scrubberIndex: number;
    lockedRange: { i0: number; iN: number } | null;
    label: string;
    nowMarkerLeft: string | null;
    showRangeToggle: boolean;
    rangeToggleLabel: string;
    visible: boolean;
    onIndexChange: (idx: number) => void;
    onJumpToNow: () => void;
    onToggleRange: () => void;
    onUseAsDeparture: (timeIso: string) => void;
  }
  let {
    windTimes, scrubberIndex, lockedRange, label,
    nowMarkerLeft, showRangeToggle, rangeToggleLabel,
    visible, onIndexChange, onJumpToNow, onToggleRange, onUseAsDeparture,
  }: Props = $props();

  let expanded = $state(true);
  const min = $derived(lockedRange?.i0 ?? 0);
  const max = $derived(lockedRange?.iN ?? Math.max(0, windTimes.length - 1));

  function handleInput(e: Event) {
    const idx = parseInt((e.target as HTMLInputElement).value);
    onIndexChange(idx);
  }
</script>

{#if visible}
<div class="scrubber-panel">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrubber-handle" title={expanded ? 'Collapse panel' : 'Expand panel'} onclick={() => expanded = !expanded}>
    <span>Time scrubber</span>
    <span class="scrubber-toggle">{expanded ? '\u25B2' : '\u25BC'}</span>
  </div>
  {#if expanded}
    <div class="scrubber-body">
      <span class="time-label">{label}</span>
      <button class="btn-use-departure" title="Set this time as the route departure time"
              onclick={() => onUseAsDeparture(windTimes[scrubberIndex] ?? '')}>
        Use as departure
      </button>
      <div class="track-wrapper">
        {#if nowMarkerLeft != null}
          <div class="now-marker" style:left={nowMarkerLeft}></div>
        {/if}
        <input type="range" {min} {max} value={scrubberIndex} oninput={handleInput} />
      </div>
      <button class="btn-jump-now" title="Jump scrubber to current time" onclick={onJumpToNow}>Now</button>
      {#if showRangeToggle}
        <button class="btn-range-toggle" title="Toggle between route duration and full GRIB range"
                onclick={onToggleRange}>
          {rangeToggleLabel}
        </button>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  .scrubber-panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #1e2230;
    border-top: 1px solid #313244;
    flex-shrink: 0;
  }
  .scrubber-handle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 12px;
    background: #2a2f45;
    font-size: 11px;
    color: #6c7086;
    cursor: pointer;
    flex-shrink: 0;
    user-select: none;
  }
  .scrubber-handle:hover {
    background: #313244;
  }
  .scrubber-body {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
  }
  .scrubber-toggle {
    background: #363a4f;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .scrubber-handle:hover .scrubber-toggle {
    background: #45475a;
  }
  .time-label {
    font-size: 11px;
    color: #a6adc8;
    white-space: nowrap;
    width: 130px;
    flex-shrink: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .track-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    position: relative;
    padding-top: 10px;
  }
  .now-marker {
    position: absolute;
    top: 0;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 7px solid #f9e2af;
    transform: translateX(-50%);
    pointer-events: none;
  }
  input[type="range"] {
    width: 100%;
    accent-color: #89b4fa;
    cursor: pointer;
  }
  .btn-use-departure {
    font-size: 10px;
    color: #a6adc8;
    background: transparent;
    border: 1px solid #45475a;
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .btn-use-departure:hover {
    color: #cdd6f4;
    border-color: #89b4fa;
  }
  .btn-jump-now {
    font-size: 10px;
    color: #a6adc8;
    background: transparent;
    border: 1px solid #45475a;
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-jump-now:hover {
    color: #cdd6f4;
    border-color: #89b4fa;
  }
  .btn-range-toggle {
    font-size: 10px;
    color: #a6adc8;
    background: transparent;
    border: 1px solid #45475a;
    border-radius: 3px;
    padding: 1px 6px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-range-toggle:hover {
    color: #cdd6f4;
    border-color: #89b4fa;
  }
</style>
