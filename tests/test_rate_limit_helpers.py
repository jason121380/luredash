import unittest

import main


class RateLimitHelperTests(unittest.TestCase):
    def setUp(self):
        main._entity_account_map.clear()

    def test_learns_entity_account_from_campaign_response(self):
        main._learn_account_from_graph_response(
            "123456789",
            {"id": "123456789", "account_id": "987654321", "name": "Campaign"},
        )

        self.assertEqual(main._account_id_for_path("123456789/adsets"), "act_987654321")

    def test_learns_nested_children_under_account_path(self):
        main._learn_account_from_graph_response(
            "act_1/campaigns",
            [
                {
                    "id": "camp_1",
                    "adsets": {"data": [{"id": "adset_1"}]},
                }
            ],
        )

        self.assertEqual(main._account_id_for_path("camp_1"), "act_1")
        self.assertEqual(main._account_id_for_path("adset_1/ads"), "act_1")

    def test_learns_creative_id_from_ad_response(self):
        main._learn_account_from_graph_response(
            "adset_1/ads",
            {"data": [{"id": "ad_1", "creative": {"id": "creative_1"}}]},
        )

        self.assertIsNone(main._account_id_for_path("creative_1"))

        main._remember_entity_account("adset_1", "act_2")
        main._learn_account_from_graph_response(
            "adset_1/ads",
            {"data": [{"id": "ad_1", "creative": {"id": "creative_1"}}]},
        )

        self.assertEqual(main._account_id_for_path("ad_1"), "act_2")
        self.assertEqual(main._account_id_for_path("creative_1"), "act_2")

    def test_expired_entity_mapping_is_ignored(self):
        main._entity_account_map["camp_1"] = ("act_1", 0.0)

        self.assertIsNone(main._account_id_for_path("camp_1/adsets"))
        self.assertNotIn("camp_1", main._entity_account_map)


if __name__ == "__main__":
    unittest.main()
