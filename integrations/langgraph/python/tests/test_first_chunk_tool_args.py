"""A tool call whose first chunk already carries its arguments.

Gemini models stream a tool call's name, id and complete arguments in one
chunk (#2653). The start branch must emit those arguments before it
returns, exactly once, so TOOL_CALL_ARGS is not lost.
"""

import asyncio
import unittest

from tests.test_nested_tool_end_dedup import (
    _filter_tool_events,
    _run_stream,
    _stream_end,
    _tool_end,
)
from tests.test_parallel_tool_calls import _multi_chunk_event


class TestArgumentsInFirstToolCallChunk(unittest.TestCase):
    def test_arguments_in_the_first_chunk_are_streamed_once(self):
        events = [
            _multi_chunk_event([{"name": "search", "id": "tc-A", "args": '{"q":"alpha"}'}]),
            _stream_end(),
            _tool_end("search", "tc-A", content="ra", input_args={"q": "alpha"}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        starts, args, ends, results = _filter_tool_events(dispatched, "tc-A")
        self.assertEqual(starts, 1)
        self.assertEqual("".join(args), '{"q":"alpha"}')
        self.assertEqual(ends, 1)
        self.assertEqual(results, 1)

    def test_a_first_chunk_without_arguments_streams_them_from_later_chunks(self):
        from tests.test_nested_tool_end_dedup import _stream_args, _stream_start

        events = [
            _stream_start("search", "tc-A"),
            _stream_args('{"q":"alpha"}', "tc-A"),
            _stream_end(),
            _tool_end("search", "tc-A", content="ra", input_args={"q": "alpha"}),
        ]
        dispatched = asyncio.run(_run_stream(events))

        _, args, _, _ = _filter_tool_events(dispatched, "tc-A")
        self.assertEqual("".join(args), '{"q":"alpha"}')
