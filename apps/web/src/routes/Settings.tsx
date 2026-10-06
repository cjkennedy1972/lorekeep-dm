import * as Switch from '@radix-ui/react-switch';
import { usePrefs, type TextSize, type Theme } from '../a11y/prefs';

export function Settings() {
  const [prefs, set] = usePrefs();
  return (
    <>
      <h1>Settings</h1>
      <div className="field">
        <label htmlFor="text-size">Text size</label>
        <select
          id="text-size"
          value={prefs.textSize}
          onChange={(e) => set({ textSize: e.target.value as TextSize })}
        >
          <option value="normal">Normal</option>
          <option value="large">Large</option>
          <option value="xlarge">Extra large</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="theme">Theme</label>
        <select
          id="theme"
          value={prefs.theme}
          onChange={(e) => set({ theme: e.target.value as Theme })}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="dyslexia">Dyslexia-friendly font</label>
        <Switch.Root
          id="dyslexia"
          className="switch"
          checked={prefs.dyslexiaFont}
          onCheckedChange={(dyslexiaFont) => set({ dyslexiaFont })}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </div>
      <div className="field">
        <label htmlFor="cvd">Colorblind-safe colors</label>
        <Switch.Root
          id="cvd"
          className="switch"
          checked={prefs.palette === 'cvd'}
          onCheckedChange={(on) => set({ palette: on ? 'cvd' : 'default' })}
        >
          <Switch.Thumb className="switch-thumb" />
        </Switch.Root>
      </div>
    </>
  );
}
