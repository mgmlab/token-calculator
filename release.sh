#!/bin/sh
# Stamp a fresh version on every CSS/JS link so browsers load the new files right away
# (GitHub Pages lets browsers cache files for 10 minutes). Run before committing a release.
V=$(date +%Y%m%d%H%M)
sed -i -E "s#(href=\"css/styles\.css|src=\"js/[a-z/._-]+\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" index.html
sed -i -E "s#(href=\"\.\./css/styles\.css|src=\"\.\./js/[a-z/._-]+\.js)(\?v=[0-9]+)?\"#\1?v=$V\"#g" docs/workload-guide.html
echo "Stamped version $V"
