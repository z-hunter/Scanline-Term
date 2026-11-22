-- Supported key codes (case-sensitive): A-Z, 0-9, Digit0-Digit9,
-- F1-F24, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, PageUp, PageDown,
-- Home, End, Insert, Delete, Backspace, Tab, Enter, NumpadEnter, Escape,
-- Space, Slash, Backslash, Quote, Comma, Period, Minus, Equal, Backquote,
-- NumpadAdd, NumpadSubtract, and Numpad0-Numpad9.
-- Modifier names: Ctrl, LeftCtrl, RightCtrl, Shift, LeftShift, RightShift,
-- Alt, LeftAlt, RightAlt, Win, LeftWin, RightWin, Menu, CapsLock.
-- Use `term` as a modifier in bindings; its physical key(s) are set above.

require('sterm').keymap({
  term = 'Menu', 
  -- 'term' is a virtual prefix key that can be assigned to any combination of physical keys.
  --[[
sterm.keymap({
  term = 'RightCtrl+RightShift',
})
]]
--  Once assigned, all shortcuts defined using 'term' will be mapped to this key combination. 

  bindings = {
    ['settings.toggle'] = { 'term+S', 'term+Backslash' },
    ['tabs.toggle_bar'] = 'term+Z',
    ['presets.toggle_picker'] = 'term+P',
    ['gallery.toggle'] = 'term+Backspace',
    ['ai.toggle'] = 'term+A',
    ['ai.toggle_focus'] = 'term+Quote',
    ['tab.new_terminal'] = 'term+N',
    ['tab.new_browser'] = 'term+B',
    ['tab.close'] = 'term+W',
    ['tab.select.1'] = 'term+Digit1', ['tab.select.2'] = 'term+Digit2',
    ['tab.select.3'] = 'term+Digit3', ['tab.select.4'] = 'term+Digit4',
    ['tab.select.5'] = 'term+Digit5', ['tab.select.6'] = 'term+Digit6',
    ['tab.select.7'] = 'term+Digit7', ['tab.select.8'] = 'term+Digit8',
    ['tab.select.9'] = 'term+Digit9', ['tab.select.10'] = 'term+Digit0',
    ['tab.next'] = { 'term+ArrowRight', 'term+Period', 'term+Shift+Period' },
    ['tab.previous'] = { 'term+ArrowLeft', 'term+Comma', 'term+Shift+Comma' },
    ['tab.last_active'] = 'term+Tab',
    ['tab.move_left'] = { 'term+Shift+ArrowLeft', 'term+Shift+H' },
    ['tab.move_right'] = { 'term+Shift+ArrowRight', 'term+Shift+L' },
    ['gallery.move_up'] = { 'term+Shift+ArrowUp', 'term+Shift+K' },
    ['gallery.move_down'] = { 'term+Shift+ArrowDown', 'term+Shift+J' },
    ['terminal.paste'] = 'term+V',
    ['terminal.copy_mode'] = 'term+C',
    ['terminal.add_image'] = 'term+I',
    ['terminal.find'] = 'term+Slash',
    ['terminal.find_back'] = 'term+Shift+Slash',
    ['terminal.page_up'] = 'term+PageUp',
    ['terminal.page_down'] = 'term+PageDown',
    ['workspace.scroll_up'] = 'term+K',
    ['workspace.scroll_down'] = 'term+J',
    ['terminal.font_decrease'] = { 'term+Minus', 'term+NumpadSubtract' },
    ['terminal.font_increase'] = { 'term+Equal', 'term+NumpadAdd' },
    ['window.toggle_fullscreen'] = { 'Alt+Enter', 'Alt+NumpadEnter' },
    ['window.toggle_visibility'] = 'Win+Backquote', -- gloabal shortcut
    ['window.show_gallery'] = 'Win+Backspace', -- gloabal shortcut
  },
})
