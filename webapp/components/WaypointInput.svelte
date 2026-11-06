<script lang="ts">
  // Waypoint picker: accepts typed coordinates or a vessel/bookmark suggestion and reports the chosen point.
  import { tryParseCoords } from '../../src/lib/coords';

  interface Props {
    label: string;
    value: { lat: number; lon: number } | null;
    suggestions: { label: string; lat: number; lon: number }[];
    vesselPosition: { lat: number; lon: number } | null;
    onSelect: (point: { lat: number; lon: number }) => void;
    onClear: () => void;
    removable?: boolean;
    onRemove?: () => void;
  }

  let {
    label,
    value,
    suggestions,
    vesselPosition,
    onSelect,
    onClear,
    removable = false,
    onRemove,
  }: Props = $props();

  let query = $state('');
  let dropdownOpen = $state(false);
  let wrapperEl: HTMLDivElement | undefined = $state();

  function formatCoord(lat: number, lon: number): string {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(4)}°${latDir}, ${Math.abs(lon).toFixed(4)}°${lonDir}`;
  }

  let filteredSuggestions = $derived.by(() => {
    const items: { label: string; lat: number; lon: number; icon: string }[] = [];
    if (vesselPosition) {
      items.push({ label: 'Current position', lat: vesselPosition.lat, lon: vesselPosition.lon, icon: '📍' });
    }
    for (const s of suggestions) {
      items.push({ label: s.label, lat: s.lat, lon: s.lon, icon: '🔖' });
    }
    if (!query.trim()) return items;
    const q = query.trim().toLowerCase();
    return items.filter(s => s.label.toLowerCase().includes(q));
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      const parsed = tryParseCoords(query);
      if (parsed) {
        onSelect(parsed);
        dropdownOpen = false;
        query = '';
      }
    } else if (e.key === 'Escape') {
      dropdownOpen = false;
    }
  }

  function handleFocus() {
    if (!value) dropdownOpen = true;
  }

  function handleInput(e: Event) {
    query = (e.target as HTMLInputElement).value;
    dropdownOpen = true;
  }

  function selectSuggestion(s: { lat: number; lon: number }) {
    onSelect({ lat: s.lat, lon: s.lon });
    dropdownOpen = false;
    query = '';
  }

  function handleClickOutside(e: MouseEvent) {
    if (wrapperEl && !wrapperEl.contains(e.target as Node)) {
      dropdownOpen = false;
    }
  }

  function handleClear() {
    if (removable && onRemove) {
      onRemove();
    } else {
      onClear();
    }
  }
</script>

<svelte:document onclick={handleClickOutside} />

<div class="waypoint-input" bind:this={wrapperEl}>
  <div class="label">{label}</div>
  {#if value}
    <div class="value-display">
      <span class="coords">{formatCoord(value.lat, value.lon)}</span>
      <button class="clear-btn" onclick={handleClear} title={removable ? 'Remove waypoint' : 'Clear'}>×</button>
    </div>
  {:else}
    <div class="input-wrapper">
      <input
        type="text"
        class="coord-input"
        placeholder="Search or enter lat, lon"
        value={query}
        onfocus={handleFocus}
        oninput={handleInput}
        onkeydown={handleKeydown}
      />
    </div>
    {#if dropdownOpen && filteredSuggestions.length > 0}
      <div class="dropdown">
        {#each filteredSuggestions as suggestion}
          <button
            class="suggestion-item"
            onclick={() => selectSuggestion(suggestion)}
          >
            <span class="suggestion-icon">{suggestion.icon}</span>
            <span class="suggestion-label">{suggestion.label}</span>
            <span class="suggestion-coords">{formatCoord(suggestion.lat, suggestion.lon)}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .waypoint-input {
    position: relative;
    width: 100%;
  }
  .label {
    font-size: 10px;
    text-transform: uppercase;
    color: #6c7086;
    letter-spacing: 0.5px;
    margin-bottom: 3px;
  }
  .coord-input {
    width: 100%;
    background: #313244;
    color: #cdd6f4;
    border: 1px solid #45475a;
    border-radius: 4px;
    font-size: 12px;
    padding: 6px 8px;
    box-sizing: border-box;
    font-family: inherit;
    outline: none;
  }
  .coord-input:focus {
    border-color: #89b4fa;
  }
  .coord-input::placeholder {
    color: #6c7086;
  }
  .input-wrapper {
    width: 100%;
  }
  .value-display {
    display: flex;
    align-items: center;
    background: #313244;
    border-radius: 4px;
    padding: 4px 8px;
    gap: 6px;
  }
  .coords {
    flex: 1;
    font-size: 12px;
    color: #cdd6f4;
  }
  .clear-btn {
    background: none;
    border: none;
    color: #6c7086;
    cursor: pointer;
    font-size: 16px;
    padding: 0 2px;
    line-height: 1;
    font-family: inherit;
  }
  .clear-btn:hover {
    color: #f38ba8;
  }
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: #2a2f45;
    border: 1px solid #45475a;
    border-radius: 6px;
    max-height: 200px;
    overflow-y: auto;
    z-index: 100;
    margin-top: 2px;
  }
  .suggestion-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 6px 8px;
    background: none;
    border: none;
    color: #cdd6f4;
    font-size: 12px;
    cursor: pointer;
    gap: 6px;
    text-align: left;
    font-family: inherit;
  }
  .suggestion-item:hover {
    background: #313244;
  }
  .suggestion-icon {
    flex-shrink: 0;
  }
  .suggestion-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .suggestion-coords {
    font-size: 10px;
    color: #6c7086;
    flex-shrink: 0;
  }
</style>
