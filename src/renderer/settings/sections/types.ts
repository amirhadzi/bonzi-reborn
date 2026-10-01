export interface Section {
  id: string;
  title: string;
  /** Short line under the page title. */
  subtitle: string;
  iconName: string;
  element: HTMLElement;
  /** Called every time the section becomes visible. */
  onShow?: () => void;
}
