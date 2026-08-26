package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/sori883/aidlc/internal/bundle"
	"github.com/sori883/aidlc/internal/distribution"
	"github.com/sori883/aidlc/internal/distribution/stage2poc"
	"github.com/sori883/aidlc/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "stage2-poc":
		runStage2PoC(os.Args[2:])
	case "bundle":
		runBundle(os.Args[2:])
	case "package-release":
		runPackageRelease(os.Args[2:])
	default:
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: aidlc-dev <stage2-poc|bundle|package-release> [options]")
}

func runStage2PoC(args []string) {
	flags := flag.NewFlagSet("stage2-poc", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	target := flags.String("target", "all", "target to build; default builds all five targets")
	output := flags.String("output", "build/stage2-poc", "ignored evidence output directory")
	skipParity := flags.Bool("skip-parity", false, "skip the Bun differential comparison")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		os.Exit(1)
	}
	repoRoot, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	outputDir := *output
	if !filepath.IsAbs(outputDir) {
		outputDir = filepath.Join(repoRoot, outputDir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	report, err := stage2poc.Run(ctx, stage2poc.Options{
		RepoRoot: repoRoot, OutputDir: outputDir, Target: *target, SkipParity: *skipParity,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(report); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runBundle(args []string) {
	if len(args) == 0 || (args[0] != "write" && args[0] != "check") {
		fmt.Fprintln(os.Stderr, "Usage: aidlc-dev bundle <write|check> [--out DIR]")
		os.Exit(1)
	}
	command := args[0]
	flags := flag.NewFlagSet("bundle "+command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	output := flags.String("out", "build/go-project", "Go Project layout output directory")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		os.Exit(1)
	}
	repoRoot, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	paths := make([]string, 0, len(distribution.Targets))
	for _, target := range distribution.Targets {
		paths = append(paths, target.ProjectPath)
	}
	files, err := bundle.Files(repoRoot, paths)
	if err != nil {
		fatal(err)
	}
	outDir := *output
	if !filepath.IsAbs(outDir) {
		outDir = filepath.Join(repoRoot, outDir)
	}
	if command == "write" {
		if err := bundle.Write(outDir, files); err != nil {
			fatal(err)
		}
		fmt.Printf("Generated %d Go Codex project files at %s.\n", len(files), outDir)
		return
	}
	result, err := bundle.Check(outDir, files)
	if err != nil {
		fatal(err)
	}
	if !result.Valid {
		content, _ := json.MarshalIndent(result, "", "  ")
		fmt.Fprintln(os.Stderr, string(content))
		os.Exit(1)
	}
	fmt.Printf("Go Codex project bundle is in sync at %s.\n", outDir)
}

func runPackageRelease(args []string) {
	flags := flag.NewFlagSet("package-release", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	output := flags.String("out", "build/go-release", "release candidate output directory")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		os.Exit(1)
	}
	repoRoot, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	outDir := *output
	if !filepath.IsAbs(outDir) {
		outDir = filepath.Join(repoRoot, outDir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	result, err := distribution.Package(ctx, distribution.PackageOptions{RepoRoot: repoRoot, OutputDir: outDir, Version: version.Version})
	if err != nil {
		fatal(err)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
