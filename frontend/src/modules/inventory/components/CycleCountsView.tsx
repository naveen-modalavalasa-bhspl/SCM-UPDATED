import { useState, useEffect } from "react";
import { Table, Button, Modal, Form, Select, DatePicker, InputNumber, Tag, Card, Space, message, Row, Col } from "antd";
import { PlusOutlined, EditOutlined, CheckCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { listCycleCounts, createCycleCount, getCycleCount, updateCycleCount, postCycleCount, inventoryApi } from "../api";
import type { WarehouseOption } from "../types";
import dayjs from "dayjs";

export function CycleCountsView() {
  const [counts, setCounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isPlanModalOpen, setIsPlanModalOpen] = useState(false);
  const [isCountModalOpen, setIsCountModalOpen] = useState(false);
  const [activeCount, setActiveCount] = useState<any>(null);
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);
  const [form] = Form.useForm();
  const [countForm] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await listCycleCounts();
      setCounts(res.items || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    inventoryApi.getWarehouses().then(setWarehouses).catch(console.error);
  }, []);

  const handlePlan = async (values: any) => {
    try {
      await createCycleCount({
        warehouse_id: values.warehouse_id,
        count_date: values.count_date.format("YYYY-MM-DD"),
        remarks: values.remarks,
      });
      message.success("Cycle count planned successfully");
      setIsPlanModalOpen(false);
      form.resetFields();
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.detail || "Failed to plan cycle count");
    }
  };

  const handleOpenCountModal = async (record: any) => {
    try {
      const detail = await getCycleCount(record.id);
      setActiveCount(detail);
      countForm.setFieldsValue({
        items: detail.items?.map((it: any) => ({
          id: it.id,
          item_name: it.item_name,
          snapshot_qty: it.snapshot_qty,
          counted_qty: it.counted_qty ?? it.snapshot_qty,
        })),
      });
      setIsCountModalOpen(true);
    } catch (e) {
      message.error("Failed to load count details");
    }
  };

  const handleSaveCount = async (values: any) => {
    try {
      await updateCycleCount(activeCount.id, {
        items: values.items.map((it: any) => ({
          id: it.id,
          counted_qty: it.counted_qty,
        })),
      });
      message.success("Count updated");
      setIsCountModalOpen(false);
      loadData();
    } catch (e: any) {
      message.error("Failed to update count");
    }
  };

  const handlePostVariance = async (id: number) => {
    try {
      await postCycleCount(id);
      message.success("Cycle count posted & variances adjusted in stock!");
      loadData();
    } catch (e: any) {
      message.error(e?.response?.data?.detail || "Failed to post cycle count");
    }
  };

  const columns = [
    { title: "Count No", dataIndex: "count_no", key: "count_no", render: (t: string) => <strong>{t}</strong> },
    { title: "Warehouse", dataIndex: "warehouse_name", key: "warehouse_name" },
    { title: "Count Date", dataIndex: "count_date", key: "count_date" },
    {
      title: "Status",
      dataIndex: "status",
      key: "status",
      render: (s: string) => {
        const color = s === "COMPLETED" ? "green" : s === "IN_PROGRESS" ? "blue" : "orange";
        return <Tag color={color}>{s}</Tag>;
      },
    },
    { title: "Planned By", dataIndex: "planned_by_name", key: "planned_by_name" },
    {
      title: "Actions",
      key: "actions",
      render: (_: any, record: any) => (
        <Space>
          {record.status !== "COMPLETED" && (
            <>
              <Button icon={<EditOutlined />} size="small" onClick={() => handleOpenCountModal(record)}>
                Enter Counts
              </Button>
              {record.status === "IN_PROGRESS" && (
                <Button type="primary" size="small" icon={<CheckCircleOutlined />} onClick={() => handlePostVariance(record.id)}>
                  Post Variance
                </Button>
              )}
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Cycle Counting</h2>
        </Col>
        <Col>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadData}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setIsPlanModalOpen(true)}>
              Plan Cycle Count
            </Button>
          </Space>
        </Col>
      </Row>

      <Card bordered>
        <Table dataSource={counts} columns={columns} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />
      </Card>

      <Modal
        title="Plan Cycle Count"
        open={isPlanModalOpen}
        onCancel={() => setIsPlanModalOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handlePlan} initialValues={{ count_date: dayjs() }}>
          <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true }]}>
            <Select placeholder="Select warehouse">
              {warehouses.map((w) => (
                <Select.Option key={w.id} value={w.id}>{w.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="count_date" label="Count Date" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`Enter Counts - ${activeCount?.count_no}`}
        open={isCountModalOpen}
        onCancel={() => setIsCountModalOpen(false)}
        onOk={() => countForm.submit()}
        width={700}
      >
        <Form form={countForm} layout="vertical" onFinish={handleSaveCount}>
          <Form.List name="items">
            {(fields) => (
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {fields.map(({ key, name, ...restField }) => {
                  const itemVal = countForm.getFieldValue(["items", name]);
                  const snapshot = itemVal?.snapshot_qty || 0;
                  return (
                    <Card key={key} size="small" style={{ marginBottom: 8, background: "#fafafa" }}>
                      <Row align="middle" gutter={16}>
                        <Col span={10}>
                          <strong>{itemVal?.item_name || `Item #${itemVal?.id}`}</strong>
                          <div style={{ fontSize: 12, color: "#8c8c8c" }}>System Snapshot: {snapshot}</div>
                        </Col>
                        <Col span={10}>
                          <Form.Item {...restField} name={[name, "counted_qty"]} label="Counted Quantity" style={{ margin: 0 }}>
                            <InputNumber min={0} style={{ width: "100%" }} />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Card>
                  );
                })}
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}
