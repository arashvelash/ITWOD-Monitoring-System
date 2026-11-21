<?php

declare(strict_types=1);

namespace Ims\Agent\Backup;

/** Storage for the archives of ONE job. Implementations stay inside that job's namespace. */
interface Destination
{
    public function prepare(): void;

    /** Moves/uploads a finished local file; returns its location URI. */
    public function store(string $file, string $name): string;

    /** @return string[] IMS archive names of this job */
    public function list(): array;

    public function remove(string $name): void;
}
