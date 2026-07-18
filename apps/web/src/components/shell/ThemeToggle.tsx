import { Moon, Sun } from 'lucide-react'
import * as React from 'react'
import { getTheme, toggleTheme, type Theme } from '@/lib/theme'
import { Button } from '../ui/Button'

// Single icon-button theme toggle: light ↔ dark. The icon shows the theme you'll switch *to* (moon while
// light, sun while dark). First launch seeds from the OS preference (see getTheme).
export function ThemeToggle() {
  const [theme, setThemeState] = React.useState<Theme>(() => getTheme())
  const next: Theme = theme === 'dark' ? 'light' : 'dark'
  return (
    <Button
      variant='ghost'
      size='icon'
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setThemeState(toggleTheme(theme))}>
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}
