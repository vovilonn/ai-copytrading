import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Тумблер настроек канала (Admin.dc.html swTrack/swKnob: 42x24 трек, 18px кружок).
// Понадобится с задачи 12 (Copy trading / Allow cross margin), заводим сейчас.
export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'relative h-6 w-[42px] flex-none cursor-pointer rounded-full bg-white/[.14] transition-colors data-[state=checked]:bg-accent',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block h-[18px] w-[18px] translate-x-[3px] rounded-full bg-white transition-transform data-[state=checked]:translate-x-[21px]" />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName
