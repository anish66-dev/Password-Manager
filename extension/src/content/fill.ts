/**
 * Sets an input's value so frameworks (React, Vue, Angular) notice it: use the native value
 * setter, then dispatch input and change events.
 */
export function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export interface FillTarget {
  password: HTMLInputElement;
  username: HTMLInputElement | null;
}

/** Fills the username (when the form has a username field) and the password. */
export function fillLogin(
  target: FillTarget,
  credentials: { username: string; password: string }
): void {
  if (target.username && credentials.username !== "") {
    setNativeValue(target.username, credentials.username);
  }
  setNativeValue(target.password, credentials.password);
}
