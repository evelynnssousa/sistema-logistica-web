import type { Icon as PhosphorIcon, IconWeight } from '@phosphor-icons/react'
import {
  AirplaneTiltIcon,
  ArrowLeftIcon,
  BellIcon,
  CalendarDotsIcon,
  CaretLeftIcon,
  BarcodeIcon,
  CoinsIcon,
  RobotIcon,
  HeadsetIcon,
  HeartbeatIcon,
  PaperclipIcon,
  TruckIcon,
  UserCheckIcon,
  StackIcon,
  CaretRightIcon,
  CarIcon,
  ChartBarIcon,
  ChartPieSliceIcon,
  CheckCircleIcon,
  ClipboardTextIcon,
  ClockCountdownIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  EraserIcon,
  EyeIcon,
  FunnelIcon,
  GearSixIcon,
  HourglassMediumIcon,
  HouseIcon,
  InfoIcon,
  KanbanIcon,
  ListChecksIcon,
  ListIcon,
  LockKeyIcon,
  MagnifyingGlassIcon,
  PackageIcon,
  PlugsConnectedIcon,
  PlusCircleIcon,
  ProhibitIcon,
  RepeatIcon,
  ScalesIcon,
  ShieldCheckIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SquaresFourIcon,
  TrayIcon,
  TreeStructureIcon,
  UserCircleIcon,
  UserPlusIcon,
  UsersThreeIcon,
  WarningCircleIcon,
  WarningIcon,
  WrenchIcon,
  XCircleIcon,
  XIcon,
} from '@phosphor-icons/react'

/**
 * Único ponto de uso da biblioteca de ícones. As telas pedem um nome de significado, e não
 * um desenho: trocar um ícone aqui vale para o sistema inteiro.
 */
const icons = {
  home: HouseIcon,
  dashboard: SquaresFourIcon,
  maintenance: WrenchIcon,
  fleet: CarIcon,
  flights: AirplaneTiltIcon,
  warehouse: PackageIcon,
  calendar: CalendarDotsIcon,
  reports: ChartBarIcon,
  settings: GearSixIcon,
  registrations: UserPlusIcon,
  users: UsersThreeIcon,
  audit: ShieldCheckIcon,
  account: UserCircleIcon,
  logout: SignOutIcon,
  menu: ListIcon,
  close: XIcon,
  add: PlusCircleIcon,
  search: MagnifyingGlassIcon,
  filter: FunnelIcon,
  clear: EraserIcon,
  previous: CaretLeftIcon,
  next: CaretRightIcon,
  back: ArrowLeftIcon,
  view: EyeIcon,
  download: DownloadSimpleIcon,
  success: CheckCircleIcon,
  error: XCircleIcon,
  warning: WarningIcon,
  attention: WarningCircleIcon,
  info: InfoIcon,
  waiting: HourglassMediumIcon,
  progress: ClockCountdownIcon,
  empty: TrayIcon,
  overview: ChartPieSliceIcon,
  requests: ClipboardTextIcon,
  inventory: ListChecksIcon,
  scales: ScalesIcon,
  lists: TreeStructureIcon,
  customize: SlidersHorizontalIcon,
  locked: LockKeyIcon,
  notifications: BellIcon,
  integrations: PlugsConnectedIcon,
  mail: EnvelopeSimpleIcon,
  denied: ProhibitIcon,
  central: HeadsetIcon,
  monitoring: HeartbeatIcon,
  attachment: PaperclipIcon,
  vehicle: TruckIcon,
  review: UserCheckIcon,
  stock: StackIcon,
  demands: KanbanIcon,
  repeat: RepeatIcon,
  money: CoinsIcon,
  robot: RobotIcon,
  barcode: BarcodeIcon,
} satisfies Record<string, PhosphorIcon>

export type IconName = keyof typeof icons

type IconProps = {
  name: IconName
  size?: number
  weight?: IconWeight
  className?: string
}

/** Navegação e ações usam "fill"; indicadores e destaques, "duotone". Sempre decorativo. */
function Icon({ name, size = 20, weight = 'fill', className }: IconProps) {
  const Glyph = icons[name]
  return <Glyph size={size} weight={weight} className={className} aria-hidden="true" />
}

export default Icon
