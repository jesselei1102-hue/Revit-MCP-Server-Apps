using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace RevitMCPCommandSet.Models.Common
{
    /// <summary>
    /// 定义可对图元执行的操作类型
    /// </summary>
    public enum ElementOperationType
    {
        /// <summary>
        /// 选择图元
        /// </summary>
        Select,

        /// <summary>
        /// 选择框
        /// </summary>
        SelectionBox,

        /// <summary>
        /// 设置图元颜色和填充
        /// </summary>
        SetColor,

        /// <summary>
        /// 设置图元透明度
        /// </summary>
        SetTransparency,

        /// <summary>
        /// 删除图元
        /// </summary>
        Delete,

        /// <summary>
        /// 隐藏图元
        /// </summary>
        Hide,

        /// <summary>
        /// 临时隐藏图元
        /// </summary>
        TempHide,

        /// <summary>
        /// 隔离图元（单独显示）
        /// </summary>
        Isolate,

        /// <summary>
        /// 取消隐藏图元
        /// </summary>
        Unhide,

        /// <summary>
        /// 重置隔离（显示所有图元）
        /// </summary>
        ResetIsolate,

        /// <summary>
        /// 清除当前视图中的图形覆盖（颜色、填充、透明度）
        /// </summary>
        ResetOverride,

        /// <summary>
        /// ResetOverride 的别名，清除 SetColor / SetTransparency 产生的覆盖
        /// </summary>
        ResetColor,

        /// <summary>
        /// SetColor 的便捷操作，将图元标红
        /// </summary>
        Highlight,

        /// <summary>
        /// 将图元改为指定族类型 / 系统类型（Element.ChangeTypeId）
        /// </summary>
        ChangeType,

        /// <summary>
        /// 设置实例参数值（parameterName + parameterValue）
        /// </summary>
        SetParameter,
    }


    /// <summary>
    /// 操作元素的设置
    /// </summary>
    public class OperationSetting
    {
        /// <summary>
        /// 需要操作的元素ID列表
        /// </summary>
        [JsonProperty("elementIds")]
        public List<long> ElementIds = new List<long>();

        /// <summary>
        /// 需要执行的动作，存储ElementOperationType枚举的string类型的值
        /// </summary>
        [JsonProperty("action")]
        public string Action { get; set; } = "Select";

        /// <summary>
        /// 透明度值(0-100)，数值越大透明度越高
        /// </summary>
        [JsonProperty("transparencyValue")]
        public int TransparencyValue { get; set; } = 50;

        /// <summary>
        /// 设置图元颜色（RGB格式），默认为红色
        /// </summary>
        [JsonProperty("colorValue")]
        public int[] ColorValue { get; set; } = new int[] { 255, 0, 0 }; // 默认红色

        /// <summary>
        /// ChangeType 目标类型 ElementId（FamilySymbol / WallType / FloorType 等）
        /// </summary>
        [JsonProperty("typeId")]
        public long TypeId { get; set; }

        /// <summary>
        /// SetParameter 参数名
        /// </summary>
        [JsonProperty("parameterName")]
        public string ParameterName { get; set; }

        /// <summary>
        /// SetParameter 参数值（显示字符串，经 SetValueString / 类型解析写入）
        /// </summary>
        [JsonProperty("parameterValue")]
        public string ParameterValue { get; set; }
    }
}
