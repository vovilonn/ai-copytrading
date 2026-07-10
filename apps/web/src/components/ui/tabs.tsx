import * as TabsPrimitive from '@radix-ui/react-tabs'
import * as React from 'react'
import { cn } from '../../lib/utils.js'

// Вкладки Messages/Settings на странице канала (Admin.dc.html:189-192, tabStyle).
// Понадобятся с задачи 12, заводим сейчас вместе с остальными shadcn-примитивами.
export const Tabs = TabsPrimitive.Root

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('flex gap-1 border-b border-white/[.08]', className)}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px cursor-pointer border-b-2 border-transparent bg-transparent px-4 py-[10px] font-sans text-[13.5px] font-medium text-muted-1 transition-colors',
      'data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-fg',
      className,
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

export const TabsContent = TabsPrimitive.Content
