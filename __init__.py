import inspect
import sys
import re

# Import everything from the nodes directory
from .nodes.nodes import *
from .nodes.power_loaders import *
from .nodes.decode_overlap import *

from .nodes.power_spline_editor import *

from .nodes.lora_extract_v2 import *
from .nodes.lora_change import *
from .nodes.lora_combine import *

from .nodes.draw_shapes import *
from .nodes.draw_joints import *
from .nodes.draw_image import *

from .nodes.image_nodes import *
from .nodes.image_nodes_extra import *
from .nodes.image_to_video import *
from .nodes.video_nodes_extra import *

from .nodes.vace_utils import *
from .nodes.cache_samples import *

# Import API endpoints to register routes
from . import api
from .utility.rgthree_api import routes_model_info

NODE_CONFIG = {}


def to_display_name(name):
    # Split CamelCase/PascalCase into words
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub('([a-z0-9])([A-Z])', r'\1 \2', s1)
    # Add " (QQ)" suffix
    return f"{s2} (QQ)"

# Dynamically populate NODE_CONFIG from imported classes
current_module = sys.modules[__name__]
for name, obj in inspect.getmembers(current_module):
    if inspect.isclass(obj):
        module_name = getattr(obj, '__module__', '')
        # Check if the class is defined in one of the modules within the .nodes package or ATI package
        if module_name.startswith(__name__ + '.nodes') or module_name.startswith(__name__ + '.ATI'):
             # --- ADDED CHECK: Exclude classes with "Math" in the name ---
             if "Math" in obj.__name__:
                 continue # Skip this class
             # --- END ADDED CHECK ---
                 
             # Basic check for ComfyUI node structure (customize if needed)
             is_comfy_node = hasattr(obj, 'INPUT_TYPES') and hasattr(obj, 'FUNCTION') and hasattr(obj, 'CATEGORY')
             if is_comfy_node:
                 class_name = obj.__name__
                 # Use explicit Node.DISPLAY_NAME if available, otherwise generate one
                 display_name = getattr(obj, 'DISPLAY_NAME', None) or to_display_name(class_name)
                 NODE_CONFIG[class_name] = {"class": obj, "name": display_name}

def generate_node_mappings(node_config):
    node_class_mappings = {}
    node_display_name_mappings = {}

    for node_name, node_info in node_config.items():
        node_class_mappings[node_name] = node_info["class"]
        node_display_name_mappings[node_name] = node_info.get("name", node_info["class"].__name__)

    return node_class_mappings, node_display_name_mappings

NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS = generate_node_mappings(NODE_CONFIG)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

WEB_DIRECTORY = "./web"

# Add static path for kjweb_async
from aiohttp import web
from server import PromptServer
from pathlib import Path

if hasattr(PromptServer, "instance"):
    try:
        PromptServer.instance.app.add_routes(
            [web.static("/kjweb_async", (Path(__file__).parent.absolute() / "kjweb_async").as_posix())]
        )
    except Exception as e:
        print(f"Error adding static route for kjweb_async: {e}")