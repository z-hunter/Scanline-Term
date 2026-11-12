local sterm = require 'sterm'

sterm.ansi_palette('users', {
  label = "User's",
  foreground = '#C0C0C0',
  background = '#000000',
  cursor = '#FFFFFF',
  colors = {
    '#000000', '#800000', '#008000', '#808000',
    '#000080', '#800080', '#008080', '#C0C0C0',
    '#808080', '#FF0000', '#00FF00', '#FFFF00',
    '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF',
  },
})
