#!/bin/zsh
# shoot.sh A|B  -> png/{X}-{map,peek,build,chat,mobile}.png
D=/Users/varun/nexconn-circle/design/r2/claude; X=$1
for s in map peek build chat; do node $D/tools/cdp.mjs shot "file://$D/$X/$s.html?still" $D/png/$X-$s.png 1440 900 ${WAIT:-9000} & done
node $D/tools/cdp.mjs shot "file://$D/$X/mobile.html?still" $D/png/$X-mobile.png 390 844 ${WAIT:-9000} &
wait
