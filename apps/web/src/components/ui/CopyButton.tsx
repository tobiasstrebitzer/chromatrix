import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type ButtonProps } from './Button'

interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  value: string
  label?: string
}

/** Icon button that copies `value` and confirms with a checkmark for a beat. */
export function CopyButton({ value, label = 'Copy', size = 'icon-sm', variant = 'ghost', ...props }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false)

  // A copy landing right before unmount would otherwise setState on a dead component.
  React.useEffect(() => () => setCopied(false), [])

  return (
    <Button
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      {...props}>
      {copied ? <Check className='text-success' /> : <Copy />}
    </Button>
  )
}
