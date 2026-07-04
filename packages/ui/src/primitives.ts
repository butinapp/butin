// @butinapp/ui/primitives — the design-system primitives: pure, prop-driven, theme-portable visual
// components with no app/IPC/Electron concept in them. The foundation every other layer composes.
export { Button, buttonVariants } from './components/button.js'
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './components/card.js'
export { Input } from './components/input.js'
export { Badge, badgeVariants } from './components/badge.js'
export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle } from './components/sheet.js'
export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from './components/dialog.js'
export { Skeleton } from './components/skeleton.js'
export { Separator } from './components/separator.js'
export { Label } from './components/label.js'
export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './components/tooltip.js'
export { Tabs, TabsList, TabsTrigger, TabsContent } from './components/tabs.js'
export { Switch } from './components/switch.js'
export { Checkbox } from './components/checkbox.js'
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem
} from './components/dropdown-menu.js'
export { Select } from './components/select.js'
export type { SelectOption } from './components/select.js'
export { Combobox } from './components/combobox.js'
export type { ComboboxProps } from './components/combobox.js'
export { ServiceIcon, ServiceIconProvider, readableOn } from './components/service-icon.js'
export type { ServiceIconResolver } from './components/service-icon.js'
export { DataTable } from './components/data-table.js'
export type { DataTableProps } from './components/data-table.js'
export type { DataTableColumn, DataTableState } from './components/data-table-model.js'
export { EChart } from './components/echart.js'
export { Sparkline } from './components/sparkline.js'
export { Progress } from './components/progress.js'
export { StatCard } from './features/charts.js'

// The class-merge helper every layer builds on.
export { cn } from './lib/utils.js'
