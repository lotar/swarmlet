#!/usr/bin/env python3
"""Unit checks for the physical expert matrix without touching hardware."""
import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("physical_matrix", HERE / "physical_matrix.py")
assert SPEC and SPEC.loader
physical_matrix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(physical_matrix)


class PhysicalMatrixTest(unittest.TestCase):
    def test_topology_contract(self):
        physical_matrix.validate_topologies()
        self.assertEqual(len(physical_matrix.TOPOLOGIES), 7)
        self.assertEqual(
            physical_matrix.TOPOLOGIES["local-control"],
            {"n1": "mac", "n2": "mac", "n3": "mac", "n4": "mac"},
        )

    def test_every_split_uses_both_legions_and_separates_replica(self):
        for name, placement in physical_matrix.TOPOLOGIES.items():
            if not name.startswith("l1-"):
                continue
            self.assertEqual(set(placement.values()), {"l1", "l2"})
            self.assertNotEqual(placement["n2"], placement["n4"])

    def test_split_names_match_active_expert_counts(self):
        for name, placement in physical_matrix.TOPOLOGIES.items():
            if not name.startswith("l1-"):
                continue
            l1 = sum(
                physical_matrix.PRIMARY_EXPERT_COUNTS[node]
                for node, host in placement.items()
                if host == "l1"
            )
            l2 = sum(
                physical_matrix.PRIMARY_EXPERT_COUNTS[node]
                for node, host in placement.items()
                if host == "l2"
            )
            self.assertEqual(name, f"l1-{l1}-l2-{l2}")

    def test_evidence_hashes_every_executed_source(self):
        self.assertEqual(
            set(physical_matrix.EVIDENCE_SOURCE_FILES),
            {
                "worker.py",
                "binary_protocol.py",
                "bundle_format.py",
                "cell.py",
                "export_bundles.py",
                "external_poc.py",
                "physical_matrix.py",
            },
        )


if __name__ == "__main__":
    unittest.main()
