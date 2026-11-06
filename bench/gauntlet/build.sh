#!/usr/bin/env bash
# Compile a fixture with the real toolchain (JDK 21 and Maven, with network access to Maven Central), for the
# compiler oracle. The copy goes to <out>; the fixture in this repository is not touched.
#
#   bench/gauntlet/build.sh orderdesk <out>
#   bench/gauntlet/build.sh shopflow <out>
#
# ShopFlow's poms leave out the MapStruct annotation processor (the real app would need it to start): the copy
# adds it, so the generated mappers are compiled facts too. Each module's classpath goes to cp.txt, for javac.
set -euo pipefail
app=$1; out=$2
root=$(cd "$(dirname "$0")/../.." && pwd)
rm -rf "$out"; cp -r "$root/fixtures/$app" "$out"; cd "$out"
if [ "$app" = shopflow ]; then
  for m in orders-service catalog-service; do
    sed -i 's|    <dependency><groupId>org.mapstruct</groupId><artifactId>mapstruct</artifactId><version>${mapstruct.version}</version></dependency>|&\n    <dependency><groupId>org.mapstruct</groupId><artifactId>mapstruct-processor</artifactId><version>${mapstruct.version}</version><scope>provided</scope></dependency>|' "$m/pom.xml"
  done
  mvn -q -B -DskipTests clean install
  for m in */; do [ -f "$m/pom.xml" ] && (cd "$m" && mvn -q -B dependency:build-classpath -Dmdep.outputFile=cp.txt); done
else
  mvn -q -B -DskipTests clean compile dependency:build-classpath -Dmdep.outputFile=cp.txt
fi
echo "built $app in $out"
