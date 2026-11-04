#!/bin/sh
# starts OrderDesk in the container
exec java -jar /app/orderdesk.jar "$@"
