package main

import (
	"fmt"
	"io"
	"os"
)

const stage1UnavailableMessage = "aidlc Go CLI is unavailable during migration Stage 1"

func run(stderr io.Writer) int {
	fmt.Fprintln(stderr, stage1UnavailableMessage)
	return 1
}

func main() {
	os.Exit(run(os.Stderr))
}
